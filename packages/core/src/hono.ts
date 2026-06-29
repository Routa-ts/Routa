import { type Context, Hono } from "hono";
import { ZodError, type z } from "zod";
import type { AnyRouteContract, HttpMethod, MiddlewareContract, RouteInput } from "./index.js";
import type { RoutaLogger } from "./logger.js";

type RuntimeResult = {
	type: string;
	data: unknown;
};

type RuntimeRouteContract = AnyRouteContract & {
	run: (args: {
		input: Record<string, unknown>;
		ctx: Record<string, unknown>;
	}) => RuntimeResult | Promise<RuntimeResult>;
	middleware?: readonly RuntimeMiddlewareContract[];
};

type RuntimeMiddlewareContract = MiddlewareContract & {
	run?: (args: {
		input: Record<string, unknown>;
		ctx: Record<string, unknown>;
		next: (ctx?: Record<string, unknown>) => Promise<RuntimeResult>;
	}) => RuntimeResult | Promise<RuntimeResult>;
};

export type HonoRoute<TCtx = unknown> = {
	method: HttpMethod;
	path: string;
	contract: AnyRouteContract;
	createContext?: () => TCtx | Promise<TCtx>;
};

export type CreateHonoAppOptions = {
	logger?: RoutaLogger;
};

/**
 * Creates a Hono app for the provided routes.
 *
 * @param routes - Route definitions to register
 * @returns The configured Hono app
 */
export function createHonoApp(
	routes: readonly HonoRoute[],
	options: CreateHonoAppOptions = {},
): Hono {
	const app = new Hono();
	const methodsByPath = new Map<string, Set<string>>();

	if (options.logger) {
		app.use("*", async (context, next) => {
			const startedAt = performance.now();

			await next();

			const url = new URL(context.req.raw.url);
			options.logger?.info("http.request", "Request completed.", {
				method: context.req.raw.method,
				path: url.pathname,
				status: context.res.status,
				durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
			});
		});
	}

	for (const route of routes) {
		const contract = route.contract as RuntimeRouteContract;

		if (route.method === "get" && contract.input?.body) {
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

				const inputReader = new RequestInputReader(context);
				const input = await inputReader.parse(contract.input);
				const ctx = toRecord(route.createContext ? await route.createContext() : {});
				const result = await runWithMiddleware(contract, input, ctx, inputReader);
				const response = validateResult(contract, result);

				return json(response.data, response.status);
			} catch (error) {
				const response = errorResponse(error);
				logRequestError(options.logger, context, error, response);
				return response;
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

/**
 * Runs route middleware and the final handler in sequence.
 *
 * Middleware can either return a runtime result or call `next()` to continue to the next step.
 * Context updates passed to `next()` are merged into the shared context object.
 *
 * @param contract - The route contract to execute
 * @param routeInput - Parsed input passed to the final handler
 * @param ctx - Shared context object available to middleware and the final handler
 * @param inputReader - Reader used to parse middleware-specific input
 * @returns The runtime result produced by middleware or the final handler
 */
async function runWithMiddleware(
	contract: RuntimeRouteContract,
	routeInput: Record<string, unknown>,
	ctx: Record<string, unknown>,
	inputReader: RequestInputReader,
): Promise<RuntimeResult> {
	const middleware = contract.middleware ?? [];

	async function dispatch(index: number): Promise<RuntimeResult> {
		const item = middleware[index];

		if (!item) {
			return await contract.run({ input: routeInput, ctx });
		}

		if (!item.run) {
			return await dispatch(index + 1);
		}

		let nextCalled = false;
		const input = await inputReader.parse(item.input);
		const result = await item.run({
			input,
			ctx,
			next: async (providedCtx = {}) => {
				if (nextCalled) {
					throw new Error("Middleware next() called multiple times.");
				}

				nextCalled = true;
				Object.assign(ctx, providedCtx);
				return await dispatch(index + 1);
			},
		});

		if (isRuntimeResult(result)) {
			return result;
		}

		if (nextCalled) {
			throw new InvalidHandlerOutputError("Middleware returned invalid output after next().");
		}

		throw new InvalidHandlerOutputError("Middleware returned invalid output.");
	}

	return await dispatch(0);
}

class RequestInputReader {
	private bodyParsed = false;
	private bodyValue: unknown;

	constructor(private readonly context: Context) {}

	async parse(input: RouteInput | undefined) {
		if (!input) {
			return {};
		}

		const request = this.context.req.raw;
		const url = new URL(request.url);

		return {
			...(input.params ? { params: parseSchema(input.params, this.context.req.param()) } : {}),
			...(input.query
				? { query: parseSchema(input.query, Object.fromEntries(url.searchParams)) }
				: {}),
			...(input.headers
				? { headers: parseSchema(input.headers, Object.fromEntries(request.headers)) }
				: {}),
			...(input.cookies ? { cookies: parseSchema(input.cookies, parseCookies(request)) } : {}),
			...(input.body ? { body: parseSchema(input.body, await this.parseBody()) } : {}),
		};
	}

	private async parseBody(): Promise<unknown> {
		if (this.bodyParsed) {
			return this.bodyValue;
		}

		this.bodyValue = await parseBody(this.context.req.raw);
		this.bodyParsed = true;
		return this.bodyValue;
	}
}

/**
 * Parses a JSON request body.
 *
 * @param request - The incoming request
 * @returns The parsed JSON value
 * @throws {Response} When the request content type is not JSON
 * @throws {InvalidJsonBodyError} When the body cannot be parsed as JSON
 */
async function parseBody(request: Request): Promise<unknown> {
	const contentType = request.headers.get("content-type") ?? "";

	if (!contentType.includes("application/json")) {
		throw new Response("Unsupported Media Type", { status: 415 });
	}

	try {
		return await request.json();
	} catch {
		throw new InvalidJsonBodyError();
	}
}

/**
 * Parses a value with the given schema.
 *
 * @param schema - The schema used to validate and transform the value
 * @param value - The value to parse
 * @returns The parsed value
 */
function parseSchema(schema: z.ZodTypeAny, value: unknown): unknown {
	return schema.parse(value);
}

/**
 * Parses cookies from the request header.
 *
 * @param request - The request containing the `cookie` header
 * @returns A record of cookie names to decoded values
 */
function parseCookies(request: Request): Record<string, string> {
	const header = request.headers.get("cookie");

	if (!header) {
		return {};
	}

	return Object.fromEntries(
		header.split(";").flatMap((item) => {
			const index = item.indexOf("=");

			if (index === -1) {
				return [];
			}

			const key = item.slice(0, index).trim();

			if (!key) {
				return [];
			}

			return [[key, decodeURIComponent(item.slice(index + 1).trim())]];
		}),
	);
}

/**
 * Validates a handler result against the declared response contract.
 *
 * @param contract - The route contract that defines allowed response types and schemas.
 * @param result - The value returned by a handler.
 * @returns A validated runtime result with the corresponding HTTP status.
 */
function validateResult(
	contract: RuntimeRouteContract,
	result: unknown,
): RuntimeResult & { status: number } {
	if (!isRuntimeResult(result)) {
		throw new InvalidHandlerOutputError("Handler returned invalid output.");
	}

	const response = contract.responses[result.type];

	if (!response) {
		throw new InvalidHandlerOutputError(`Handler returned unknown response type "${result.type}".`);
	}

	try {
		return {
			type: result.type,
			data: parseSchema(response.schema, result.data),
			status: response.status,
		};
	} catch (error) {
		if (error instanceof ZodError) {
			throw new InvalidHandlerOutputError(
				"Handler returned response data that does not match schema.",
			);
		}

		throw error;
	}
}

/**
 * Determines whether a value matches the runtime result shape.
 *
 * @param value - The value to check
 * @returns `true` if the value is a non-null object with a string `type` property and a `data` property, `false` otherwise.
 */
function isRuntimeResult(value: unknown): value is RuntimeResult {
	return (
		typeof value === "object"
		&& value !== null
		&& "type" in value
		&& typeof value.type === "string"
		&& "data" in value
	);
}

/**
 * Converts an object-like value to a plain record.
 *
 * @returns The value as a record when it is a non-array object, or an empty object otherwise.
 */
function toRecord(value: unknown): Record<string, unknown> {
	if (typeof value === "object" && value !== null && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}

	return {};
}

/**
 * Creates a JSON response.
 *
 * @param data - The response body to serialize as JSON
 * @param status - The HTTP status code for the response
 * @returns A `Response` with a JSON body and `application/json; charset=utf-8` content type
 */
function json(data: unknown, status: number): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
		},
	});
}

/**
 * Determines whether a request accepts JSON responses.
 *
 * @returns `true` if the `Accept` header allows `application/json`, `application/*`, or `*/*`, `false` otherwise.
 */
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

/**
 * Converts an error into an HTTP response.
 *
 * @returns A response that preserves `Response` values and maps known error types to problem JSON responses.
 */
function errorResponse(error: unknown): Response {
	if (error instanceof Response) {
		return error;
	}

	if (error instanceof InvalidHandlerOutputError) {
		return json(
			{
				type: "https://routa.dev/problems/handler-output",
				title: "Invalid handler output",
				status: 500,
			},
			500,
		);
	}

	if (error instanceof InvalidJsonBodyError) {
		return json(
			{
				type: "https://routa.dev/problems/invalid-json",
				title: "Invalid JSON body",
				status: 400,
			},
			400,
		);
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

/**
 * Logs failed server requests.
 *
 * @param context - The request context.
 * @param error - The error associated with the failure.
 * @param response - The response returned for the request.
 */
function logRequestError(
	logger: RoutaLogger | undefined,
	context: Context,
	error: unknown,
	response: Response,
): void {
	if (!logger || response.status < 500) {
		return;
	}

	const url = new URL(context.req.raw.url);
	const data = {
		method: context.req.raw.method,
		path: url.pathname,
		status: response.status,
		...errorLogData(error),
	};

	logger.error("http.error", "Request failed.", data);
}

/**
 * Builds structured log data for an error value.
 *
 * @param error - The error value to describe
 * @returns An object containing error details, or a stringified error value for non-`Error` inputs
 */
function errorLogData(error: unknown): Record<string, unknown> {
	if (error instanceof Error) {
		return {
			error: error.message,
			name: error.name,
			stack: error.stack,
		};
	}

	return {
		error: String(error),
	};
}

class InvalidHandlerOutputError extends Error {}

class InvalidJsonBodyError extends Error {}
