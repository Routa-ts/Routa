import { Hono } from "hono";
import type { AnyRouteContract, HttpMethod, ResponseValidation } from "./index.js";
import { createLogger, type RoutaLogger } from "./logger.js";
import {
	createRequestExecutor,
	isBodylessStatus,
	type RequestScope,
	type RuntimeRouteContract,
} from "./request-execution.js";
import { cookieDeclarationProblem, cookieScopeWarnings } from "./response-cookies.js";
import { headerDeclarationProblem, lifecycleOwnedHeaders } from "./response-headers.js";
import {
	type ApplicationServicesDeclaration,
	constructServices,
	createCleanupScope,
	logCleanupFailure,
	type RequestServicesDeclaration,
	type ServiceMapping,
} from "./services.js";

export { isBodylessStatus };
export type { ApplicationServicesDeclaration, RequestServicesDeclaration };

type RuntimeMode = "dev" | "start";

export type HonoRoute<TCtx = unknown> = {
	method: HttpMethod;
	path: string;
	contract: AnyRouteContract;
	createContext?: () => TCtx | Promise<TCtx>;
	/**
	 * The route file's and the method's services. Each factory runs once per request, after the
	 * middleware that precede it; its services join `ctx.services` for the rest of the chain.
	 */
	services?: RouteServices;
	/**
	 * The names messages use for each middleware in `contract.middleware`, in chain order, such as
	 * the export names `routa generate` read. Middleware without a name is called `middleware[i]`.
	 */
	middlewareNames?: readonly string[];
};

/** The request-scoped services one route method combines: its route file's, then its own. */
export type RouteServices = {
	readonly routeFile?: RequestServicesDeclaration | undefined;
	readonly method?: RequestServicesDeclaration | undefined;
};

export type CreateHonoAppOptions = {
	logger?: RoutaLogger;
	lifecycleHeaders?: boolean;
	/** Defaults to `"development"`. */
	responseValidation?: ResponseValidation;
	/** Explicit runtime command mode. Defaults to `"dev"` for direct low-level use. */
	runtimeMode?: RuntimeMode;
};

export type CreateApplicationOptions = CreateHonoAppOptions & {
	/** The `services` factory from `createRouta` and the names its contract declares. */
	services?: ApplicationServicesDeclaration;
};

/** One application instance: its routes, its application services, and their cleanup. */
export type RoutaApplication = {
	/** Handles one request. Rejects once disposal has started. */
	readonly fetch: (request: Request) => Promise<Response>;
	/**
	 * Stops accepting requests, waits for accepted ones to settle, then releases application
	 * services once. Repeated and concurrent calls share one outcome. It rejects, after every
	 * cleanup callback has been attempted, when any of them failed. It sets no deadline: a request
	 * or callback that never settles keeps disposal pending.
	 */
	readonly dispose: () => Promise<void>;
};

/**
 * Creates an application instance: it runs the application services factory once, then
 * registers the routes with the services exposed as `ctx.services`.
 *
 * A factory failure rejects with the factory's error after the cleanup it registered has run.
 * A route registration failure releases the constructed services and rejects with the
 * registration error. Cleanup failures on these paths are logged and never replace the error.
 *
 * @param routes - Route definitions to register
 * @returns The application instance, once its services are constructed
 */
export async function createApplication(
	routes: readonly HonoRoute[],
	options: CreateApplicationOptions = {},
): Promise<RoutaApplication> {
	const { services: declaration, ...appOptions } = options;
	const logger = appOptions.logger ?? createLogger({ enabled: false });
	const scope = createCleanupScope();
	const services =
		declaration
		&& (await constructServices(
			(onCleanup) => declaration.factory({ logger, onCleanup }),
			declaration.names,
			"application services factory",
			scope,
			logger,
		));
	let app: Hono;

	try {
		app = honoApp(routes, appOptions, services);
	} catch (error) {
		await scope.release().catch((cleanupError: unknown) => logCleanupFailure(logger, cleanupError));
		throw error;
	}

	const accepted = new Set<Promise<Response>>();
	let disposal: Promise<void> | undefined;

	return Object.freeze({
		fetch: async (request: Request) => {
			if (disposal) {
				throw new Error("This Routa application is being disposed, so it accepts no new requests.");
			}

			const response = Promise.resolve(app.fetch(request));
			accepted.add(response);

			try {
				return await response;
			} finally {
				accepted.delete(response);
			}
		},
		dispose: () =>
			(disposal ??= (async () => {
				await Promise.allSettled(accepted);
				await scope.release();
			})()),
	});
}

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
	return honoApp(routes, options, undefined);
}

function honoApp(
	routes: readonly HonoRoute[],
	options: CreateHonoAppOptions,
	services: ServiceMapping | undefined,
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

		assertOutcomeDeclarations(
			contract,
			route.path,
			route.method,
			options.lifecycleHeaders,
			routeLogger,
		);
		assertUniqueOutcomeNames(contract, route.path, method);
		assertReservedContext(contract, routeKey);
		assertRouteServices(route, routeKey, services);

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
			services,
			requestServices: requestScopes(route.services, routeKey),
			route: routeKey,
			middlewareNames: route.middlewareNames,
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
	logger: RoutaLogger,
): void {
	const label = `${method.toUpperCase()} ${path}`;
	const lifecycleOwned = lifecycleOwnedHeaders(contract.deprecation, lifecycleHeaders);

	for (const [name, outcome] of Object.entries(contract.responses)) {
		const problem = outcomeProblem(outcome, method, lifecycleOwned);

		if (problem) {
			throw new Error(`Outcome "${name}" on ${label} ${problem}`);
		}

		warnCookieScopes(logger, `Outcome "${name}" on ${label}`, outcome);
	}

	for (const item of contract.middleware ?? []) {
		for (const [name, outcome] of Object.entries(item.rejects ?? {}) as Array<
			[string, { status: number; schema?: unknown; headers?: unknown; cookies?: unknown }]
		>) {
			const problem = outcomeProblem(outcome, method, lifecycleOwned);

			if (problem) {
				throw new Error(`Middleware reject "${name}" on ${label} ${problem}`);
			}

			warnCookieScopes(logger, `Middleware reject "${name}" on ${label}`, outcome);
		}
	}
}

/** Logs a warning for each name an outcome declares with more than one scope. */
function warnCookieScopes(
	logger: RoutaLogger,
	label: string,
	outcome: { cookies?: unknown },
): void {
	for (const warning of cookieScopeWarnings(outcome.cookies)) {
		logger.warn("cookies.scope", `${label}: ${warning}`);
	}
}

function outcomeProblem(
	outcome: { status: number; schema?: unknown; headers?: unknown; cookies?: unknown },
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
		const problem = headerDeclarationProblem(outcome.headers, lifecycleOwned);

		if (problem) {
			return problem;
		}
	}

	if (outcome.cookies !== undefined) {
		return cookieDeclarationProblem(outcome.cookies);
	}

	return undefined;
}

/**
 * Rejects middleware that provides `ctx.services`, which Routa reserves for injected services.
 * TypeScript and `routa check` report the same rule; this covers contracts typed through `any`.
 */
function assertReservedContext(contract: RuntimeRouteContract, label: string): void {
	for (const [index, item] of (contract.middleware ?? []).entries()) {
		if (item.provides && Object.hasOwn(item.provides, "services")) {
			throw new Error(
				`middleware[${index}] on ${label} provides ctx.services, which Routa reserves for injected services. Rename the provided key.`,
			);
		}
	}
}

/** Orders a route's request-scoped factories as they run: route file, then method. */
function requestScopes(services: RouteServices | undefined, label: string): RequestScope[] {
	const { routeFile, method } = services ?? {};
	return [
		...(routeFile ? [{ ...routeFile, label: `route-file services factory for ${label}` }] : []),
		...(method ? [{ ...method, label: `method services factory for ${label}` }] : []),
	];
}

/**
 * Rejects request-scoped services that cannot be combined for one request: a factory placed
 * outside the middleware chain, method services placed before route-file services, or a service
 * name that more than one combined scope declares. Unrelated routes and methods may reuse names.
 */
function assertRouteServices(
	route: HonoRoute,
	label: string,
	application: ServiceMapping | undefined,
): void {
	const chain = route.contract.middleware?.length ?? 0;
	const { routeFile, method } = route.services ?? {};
	const owners = new Map(
		Object.keys(application ?? {}).map((name) => [name, "application services"]),
	);

	for (const [scope, declaration] of [
		["route-file services", routeFile],
		["method services", method],
	] as const) {
		if (!declaration) {
			continue;
		}

		if (
			!Number.isInteger(declaration.after)
			|| declaration.after < 0
			|| declaration.after > chain
		) {
			throw new Error(
				`The ${scope} on ${label} run after ${declaration.after} middleware, but the route has ${chain}.`,
			);
		}

		for (const name of declaration.names) {
			const owner = owners.get(name);

			if (owner) {
				throw new Error(
					`Service "${name}" on ${label} is declared by ${owner} and by ${scope}. Services combined for one request need distinct names.`,
				);
			}

			owners.set(name, scope);
		}
	}

	if (routeFile && method && method.after < routeFile.after) {
		throw new Error(`The method services on ${label} cannot run before its route-file services.`);
	}
}

/**
 * Ensures every outcome that can end a route has its own name: route outcomes and the rejects of
 * every middleware in its chain. The handler result names its outcome, so two producers sharing a
 * name would leave Routa to choose one.
 *
 * @param contract - The route contract whose outcome names are checked
 * @param path - The route path, used in the error message
 * @param method - The HTTP method, used in the error message
 */
function assertUniqueOutcomeNames(
	contract: RuntimeRouteContract,
	path: string,
	method: string,
): void {
	const seen = new Map<string, string>(
		Object.keys(contract.responses).map((type) => [type, "the route"]),
	);

	for (const [index, item] of (contract.middleware ?? []).entries()) {
		const label = `middleware[${index}]`;

		for (const type of Object.keys(item.rejects ?? {})) {
			const previous = seen.get(type);

			if (previous) {
				throw new Error(
					`Outcome "${type}" on ${method} ${path} is declared by ${previous} and by ${label}. Give each outcome its own name.`,
				);
			}

			seen.set(type, label);
		}
	}
}
