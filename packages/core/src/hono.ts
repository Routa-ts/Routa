import { Hono } from "hono";
import type { AnyRouteContract, HttpMethod, ResponseValidation } from "./index.js";
import { createLogger, type RoutaLogger } from "./logger.js";
import {
	createRequestExecutor,
	isBodylessStatus,
	type RuntimeRouteContract,
} from "./request-execution.js";
import { headerDeclarationProblem, lifecycleOwnedHeaders } from "./response-headers.js";

export { isBodylessStatus };

type RuntimeMode = "dev" | "start";

export type HonoRoute<TCtx = unknown> = {
	method: HttpMethod;
	path: string;
	contract: AnyRouteContract;
	createContext?: () => TCtx | Promise<TCtx>;
};

export type CreateHonoAppOptions = {
	logger?: RoutaLogger;
	lifecycleHeaders?: boolean;
	/** Defaults to `"development"`. */
	responseValidation?: ResponseValidation;
	/** Explicit runtime command mode. Defaults to `"dev"` for direct low-level use. */
	runtimeMode?: RuntimeMode;
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
	const routeLogger = options.logger ?? createLogger({ enabled: false });
	const validateResponses = shouldValidateResponses(options);

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

	const registeredRoutes = new Set<string>();

	for (const route of routes) {
		if ((route.method as string) === "options") {
			throw new Error(
				`OPTIONS ${route.path} cannot be declared explicitly. Routa generates OPTIONS from the path's route methods.`,
			);
		}
	}

	const registrationRoutes = [
		...routes.filter((route) => route.method === "head"),
		...routes.filter((route) => route.method !== "head"),
	];

	// Hono dispatches HEAD through its GET router. Register explicit HEAD contracts
	// first as guarded GET handlers so they win without intercepting real GETs.
	for (const route of registrationRoutes) {
		const contract = route.contract as RuntimeRouteContract;
		const method = route.method.toUpperCase();
		const routeKey = `${method} ${route.path}`;

		if (registeredRoutes.has(routeKey)) {
			throw new Error(`Duplicate route registration: ${routeKey}`);
		}

		registeredRoutes.add(routeKey);

		if ((route.method === "get" || route.method === "head") && contract.input?.body) {
			throw new Error(`${route.method.toUpperCase()} ${route.path} cannot declare a request body.`);
		}

		assertOutcomeDeclarations(contract, route.path, route.method, options.lifecycleHeaders);
		assertUniqueMiddlewareRejects(contract, route.path, method);

		const methods = methodsByPath.get(route.path) ?? new Set<string>();
		methods.add(method);
		methodsByPath.set(route.path, methods);

		const honoMethod = route.method === "head" ? "GET" : method;
		const executeRoute = createRequestExecutor(contract, {
			logger: routeLogger,
			validateResponses,
			lifecycleHeaders: options.lifecycleHeaders,
			requestLogger: options.logger,
			createContext: route.createContext,
		});

		app.on(honoMethod, route.path, async (context, next) => {
			if (route.method === "head" && context.req.raw.method !== "HEAD") {
				return await next();
			}

			return executeRoute(context.req.raw, context.req.param());
		});
	}

	for (const [path, methods] of methodsByPath) {
		const allowedMethods = new Set(methods);

		if (allowedMethods.has("GET")) {
			allowedMethods.add("HEAD");
		}

		allowedMethods.add("OPTIONS");
		const allow = Array.from(allowedMethods).sort().join(", ");

		app.on("OPTIONS", path, (context) => {
			return new Response(null, {
				status: 204,
				headers: automaticOptionsHeaders(context.req.raw, allow),
			});
		});

		app.all(path, () => {
			return new Response("Method Not Allowed", {
				status: 405,
				headers: {
					allow,
				},
			});
		});
	}

	return app;
}

/**
 * Builds automatic OPTIONS headers without granting cross-origin access.
 *
 * `Allow` describes HTTP method support for every OPTIONS request. A browser
 * preflight also receives the derived method list and cache variance metadata;
 * an explicit CORS policy remains responsible for `Access-Control-Allow-Origin`
 * and allowed request headers.
 */
function automaticOptionsHeaders(request: Request, allow: string): Headers {
	const headers = new Headers({ allow });
	const origin = request.headers.get("origin");
	const requestedMethod = request.headers.get("access-control-request-method");

	if (origin && requestedMethod) {
		headers.set("access-control-allow-methods", allow);
		headers.set("vary", "Origin, Access-Control-Request-Method, Access-Control-Request-Headers");
	}

	return headers;
}

function shouldValidateResponses(options: CreateHonoAppOptions): boolean {
	const policy = options.responseValidation ?? "development";
	const runtimeMode = options.runtimeMode ?? "dev";
	return policy === "always" || runtimeMode === "dev";
}

/**
 * Rejects outcome declarations that HTTP or the route method forbids, before the app serves traffic.
 *
 * TypeScript and `routa check` report the same rules earlier. This keeps hand-built contracts honest.
 */
function assertOutcomeDeclarations(
	contract: RuntimeRouteContract,
	path: string,
	method: HttpMethod,
	lifecycleHeaders: boolean | undefined,
): void {
	const label = `${method.toUpperCase()} ${path}`;
	const lifecycleOwned = lifecycleOwnedHeaders(contract.deprecation, lifecycleHeaders);

	for (const [name, outcome] of Object.entries(contract.responses)) {
		const problem = outcomeProblem(outcome, method, lifecycleOwned);

		if (problem) {
			throw new Error(`Outcome "${name}" on ${label} ${problem}`);
		}
	}

	for (const item of contract.middleware ?? []) {
		for (const [name, outcome] of Object.entries(item.rejects ?? {}) as Array<
			[string, { status: number; schema?: unknown; headers?: unknown }]
		>) {
			const problem = outcomeProblem(outcome, undefined, lifecycleOwned);

			if (problem) {
				throw new Error(`Middleware reject "${name}" on ${label} ${problem}`);
			}
		}
	}
}

function outcomeProblem(
	outcome: { status: number; schema?: unknown; headers?: unknown },
	method: HttpMethod | undefined,
	lifecycleOwned: ReadonlySet<string>,
): string | undefined {
	const { status } = outcome;

	if (status < 200) {
		return `declares status ${status}. Informational (1xx) statuses cannot be terminal outcomes; use a status from 200 to 599.`;
	}

	if (outcome.schema && isBodylessStatus(status)) {
		return `declares a schema for status ${status}, which has no body. Remove \`schema\`.`;
	}

	if (outcome.schema && method === "head") {
		return "declares a schema, but HEAD responses have no body. Remove `schema`.";
	}

	if (status === 304 && method && method !== "get" && method !== "head") {
		return `declares status 304, which is valid only for GET and HEAD routes.`;
	}

	if (outcome.headers !== undefined) {
		return headerDeclarationProblem(outcome.headers, lifecycleOwned);
	}

	return undefined;
}

/**
 * Ensures middleware reject keys are unique across a route's middleware chain.
 *
 * @param contract - The route contract whose middleware rejects are checked
 * @param path - The route path, used in the error message
 * @param method - The HTTP method, used in the error message
 */
function assertUniqueMiddlewareRejects(
	contract: RuntimeRouteContract,
	path: string,
	method: string,
): void {
	const seen = new Map<string, string>();

	for (const [index, item] of (contract.middleware ?? []).entries()) {
		const label = `middleware[${index}]`;

		for (const type of Object.keys(item.rejects ?? {})) {
			const previous = seen.get(type);

			if (previous) {
				throw new Error(
					`Duplicate middleware reject key "${type}" on ${method} ${path} (${previous} and ${label}).`,
				);
			}

			seen.set(type, label);
		}
	}
}
