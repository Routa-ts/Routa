import { type Context, Hono } from "hono";
import { ZodError, type z } from "zod";
import type { HttpMethod, RouteContract, RouteInput, RouteResponses } from "./index.js";

export type HonoRoute<
	TInput extends RouteInput | undefined = RouteInput | undefined,
	TResponses extends RouteResponses = RouteResponses,
	TCtx = unknown,
> = {
	method: HttpMethod;
	path: string;
	contract: RouteContract<TInput, TResponses, TCtx>;
	createContext?: () => TCtx | Promise<TCtx>;
};

export function createHonoApp(routes: readonly HonoRoute[]): Hono {
	const app = new Hono();
	const methodsByPath = new Map<string, Set<string>>();

	for (const route of routes) {
		if (route.method === "get" && route.contract.input?.body) {
			throw new Error(`GET ${route.path} cannot declare a request body.`);
		}

		const methods = methodsByPath.get(route.path) ?? new Set<string>();
		methods.add(route.method.toUpperCase());
		methodsByPath.set(route.path, methods);

		app.on(route.method.toUpperCase(), route.path, async (context) => {
			try {
				if (!acceptsJson(context.req.raw)) {
					return new Response("Not Acceptable", { status: 406 });
				}

				const input = await parseInput(route.contract.input, context);
				const ctx = route.createContext ? await route.createContext() : {};
				const result = await route.contract.run({ input, ctx });
				const response = route.contract.responses[result.type];

				return json(result.data, response.status);
			} catch (error) {
				return errorResponse(error);
			}
		});
	}

	for (const [path, methods] of methodsByPath) {
		app.all(path, () => {
			return new Response("Method Not Allowed", {
				status: 405,
				headers: {
					allow: Array.from(methods).sort().join(", "),
				},
			});
		});
	}

	return app;
}

async function parseInput(input: RouteInput | undefined, context: Context) {
	if (!input) {
		return {};
	}

	const request = context.req.raw;
	const url = new URL(request.url);

	return {
		...(input.params ? { params: parseSchema(input.params, context.req.param()) } : {}),
		...(input.query
			? { query: parseSchema(input.query, Object.fromEntries(url.searchParams)) }
			: {}),
		...(input.headers
			? { headers: parseSchema(input.headers, Object.fromEntries(request.headers)) }
			: {}),
		...(input.body ? { body: parseSchema(input.body, await parseBody(request)) } : {}),
	};
}

async function parseBody(request: Request): Promise<unknown> {
	const contentType = request.headers.get("content-type") ?? "";

	if (!contentType.includes("application/json")) {
		throw new Response("Unsupported Media Type", { status: 415 });
	}

	return await request.json();
}

function parseSchema(schema: z.ZodTypeAny, value: unknown): unknown {
	return schema.parse(value);
}

function json(data: unknown, status: number): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
		},
	});
}

function acceptsJson(request: Request): boolean {
	const accept = request.headers.get("accept");

	if (!accept) {
		return true;
	}

	return accept
		.split(",")
		.map((value) => value.trim().split(";")[0])
		.some((value) => value === "*/*" || value === "application/*" || value === "application/json");
}

function errorResponse(error: unknown): Response {
	if (error instanceof Response) {
		return error;
	}

	if (error instanceof ZodError) {
		return json(
			{
				type: "https://routa.dev/problems/validation",
				title: "Validation failed",
				status: 400,
				issues: error.issues.map((issue) => ({
					path: issue.path,
					message: issue.message,
				})),
			},
			400,
		);
	}

	return json(
		{
			type: "https://routa.dev/problems/internal",
			title: "Internal Server Error",
			status: 500,
		},
		500,
	);
}
