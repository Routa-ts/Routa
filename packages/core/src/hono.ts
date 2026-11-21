import { type Context, Hono } from "hono";
import {
	isAuthenticationGuard,
	rejectsAmbiguousCredentials,
	type RouteAuthentication,
	routeAuthentication,
	runtimeAuthentication,
} from "./authentication.js";
import type {
	AnyRouteContract,
	AuthenticationConfig,
	CorrelationConfig,
	HttpMethod,
	RequestErrorDiagnostic,
	RequestErrorReporter,
	ResponseValidation,
} from "./index.js";
import { createLogger, type RoutaLogger } from "./logger.js";
import { assertCreatedLogger, requestLoggers } from "./logger-registry.js";
import {
	createRequestExecutor,
	internalErrorResponse,
	isBodylessStatus,
	logRequestError,
	type RequestScope,
	type RuntimeRouteContract,
} from "./request-execution.js";
import {
	buildProjectApplication,
	type CreateProjectApplicationOptions,
	type ProjectApplication,
	type ProjectModuleLoader,
} from "./project.js";
import { type ReportRequestError, requestErrorReporterOf } from "./request-errors.js";
import {
	acceptedCorrelation,
	assertCorrelationReadsNoCredential,
	correlationHeaderOf,
	loggedMethod,
	type RequestIdentity,
	requestIdHeader,
	type RequestState,
	unmatchedRoute,
} from "./request-identity.js";
import { cookieDeclarationProblem, cookieScopeWarnings } from "./response-cookies.js";
import {
	headerDeclarationProblem,
	lifecycleOwnedHeaders,
	type OwnedHeaders,
} from "./response-headers.js";
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
export type {
	CreateProjectApplicationOptions,
	ProjectApplication,
	ProjectModuleLoader,
	ServiceReplacements,
} from "./project.js";

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
	/**
	 * The `authentication` from `createRouta`. Every route resolves `ctx.auth` from the request's
	 * credential before negotiation, input, and middleware, and `requireAuth` guards enforce it.
	 */
	authentication?: AuthenticationConfig;
	/** The `correlation` from `createRouta`: which request header carries a correlation ID. */
	correlation?: CorrelationConfig;
	/**
	 * The `onRequestError` from `createRouta`: observes each unexpected request failure and
	 * response contract violation, whether or not a logger is configured.
	 */
	onRequestError?: RequestErrorReporter;
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
 * @throws {TypeError} When `options.logger` is not a logger `createLogger` created
 */
export async function createApplication(
	routes: readonly HonoRoute[],
	options: CreateApplicationOptions = {},
): Promise<RoutaApplication> {
	const { services: declaration, ...appOptions } = options;
	const requestLogger = appOptions.logger;
	if (requestLogger !== undefined) {
		assertCreatedLogger(
			requestLogger,
			"createApplication received",
			"Omit logger to turn logging off.",
		);
	}
	// Read before the services factory runs, so the factory cannot change the header requests use,
	// or the reporter.
	const correlationHeader = correlationHeaderOf(appOptions.correlation);
	const report = requestErrorReporterOf(appOptions.onRequestError);
	const logger = requestLogger ?? createLogger({ enabled: false });
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
		app = honoApp(routes, appOptions, services, { requestLogger, correlationHeader, report });
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
 * Builds a project's application instance without listening: it loads the generated route
 * metadata, `src/routa.ts`, the route modules, and their middleware, then constructs the
 * application services. `routa start` and generated test applications both build through it.
 *
 * @param load - Imports a project module by its path from the project root
 * @throws When a replacement names a route, method, or scope that declares no services, when
 *   `src/routa.ts` or a route file and the generated metadata disagree about services, or when
 *   the application services factory fails
 */
export function createProjectApplication(
	load: ProjectModuleLoader,
	options: CreateProjectApplicationOptions,
): Promise<ProjectApplication> {
	return buildProjectApplication(load, options, createApplication);
}

/**
 * Creates a Hono app for the provided routes. It provides no application services, so a route
 * that reads them needs {@link createApplication} with a services factory. Route-file and method
 * services from `routes[].services` still run.
 *
 * @param routes - Route definitions to register
 * @returns The configured Hono app
 * @throws {TypeError} When `options.logger` is not a logger `createLogger` created
 */
export function createHonoApp(
	routes: readonly HonoRoute[],
	options: CreateHonoAppOptions = {},
): Hono {
	// Read the logger once, so the logger checked here is the one every request uses.
	const logger = options.logger;
	if (logger !== undefined) {
		assertCreatedLogger(logger, "createHonoApp received", "Omit logger to turn logging off.");
	}
	return honoApp(routes, options, undefined, {
		requestLogger: logger,
		correlationHeader: correlationHeaderOf(options.correlation),
		report: requestErrorReporterOf(options.onRequestError),
	});
}

/**
 * The options read once and checked at startup, so a later change to the options cannot replace
 * them: the logger, the correlation header, and the contained `onRequestError`.
 */
type CheckedOptions = {
	readonly requestLogger: RoutaLogger | undefined;
	readonly correlationHeader: string | undefined;
	readonly report: ReportRequestError | undefined;
};

/**
 * @param options - Read as given, except for the options `checked` holds
 */
function honoApp(
	routes: readonly HonoRoute[],
	options: Omit<CreateHonoAppOptions, "logger" | "correlation" | "onRequestError">,
	services: ServiceMapping | undefined,
	{ requestLogger, correlationHeader, report }: CheckedOptions,
): Hono {
	const app = new Hono();
	const methodsByPath = new Map<string, Set<string>>();
	const routeLogger = requestLogger ?? createLogger({ enabled: false });
	const validateResponses = shouldValidateResponses(options);
	const authentication =
		options.authentication === undefined
			? undefined
			: runtimeAuthentication(options.authentication);
	assertCorrelationReadsNoCredential(correlationHeader, authentication);
	const requests = identifyRequests(app, routeLogger, correlationHeader, report);

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
		const method = route.method.toUpperCase();
		const routeKey = `${method} ${route.path}`;
		const declared = route.contract as RuntimeRouteContract;
		// The one place a route's accepted schemes are decided, from every requireAuth in its chain.
		const middleware = declared.middleware ?? [];
		const prepared = routeAuthentication(middleware, authentication, routeKey, method === "HEAD");
		const contract: RuntimeRouteContract =
			prepared.middleware === middleware
				? declared
				: {
						...declared,
						middleware: prepared.middleware as NonNullable<RuntimeRouteContract["middleware"]>,
					};

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
			correlationHeader,
			routeLogger,
		);
		assertUniqueOutcomeNames(contract, route.path, method, prepared.authentication);
		assertReservedContext(contract, routeKey, authentication !== undefined);
		assertRouteServices(route, routeKey, services);

		const methods = methodsByPath.get(route.path) ?? new Set<string>();
		methods.add(method);
		methodsByPath.set(route.path, methods);

		const honoMethod = route.method === "head" ? "GET" : method;
		const executeRoute = createRequestExecutor(contract, {
			validateResponses,
			lifecycleHeaders: options.lifecycleHeaders,
			createContext: route.createContext,
			services,
			authentication: prepared.authentication,
			head: method === "HEAD",
			requestServices: requestScopes(route.services, routeKey),
			route: routeKey,
			path: route.path,
			middlewareNames: route.middlewareNames,
			report,
		});

		app.on(honoMethod, route.path, async (context, next) => {
			if (route.method === "head" && context.req.raw.method !== "HEAD") {
				return await next();
			}

			return requests.answer(context, route.path, (state) =>
				executeRoute(context.req.raw, context.req.param(), state),
			);
		});
	}

	for (const [path, methods] of methodsByPath) {
		const allowedMethods = new Set(methods);

		if (allowedMethods.has("GET")) {
			allowedMethods.add("HEAD");
		}

		allowedMethods.add("OPTIONS");
		const allow = Array.from(allowedMethods).sort().join(", ");

		app.on("OPTIONS", path, (context) =>
			requests.answer(
				context,
				path,
				() =>
					new Response(null, {
						status: 204,
						headers: automaticOptionsHeaders(context.req.raw, allow),
					}),
			),
		);

		app.all(path, (context) =>
			requests.answer(
				context,
				path,
				() =>
					new Response("Method Not Allowed", {
						status: 405,
						headers: {
							allow,
						},
					}),
			),
		);
	}

	return app;
}

/**
 * A request's identity, the correlation header of the app that identified it, the route pattern
 * that matched it, and the response Routa prepared for it.
 */
type TrackedRequest = {
	readonly requestId: string;
	/** Removed when a mounted Routa app refuses the request, so the owner never echoes or logs it. */
	correlationId?: string;
	readonly correlationHeader: string | undefined;
	route?: string;
	prepared?: Response;
};

/**
 * The identity of each request a Routa app is handling, by its Hono context. When one Routa app
 * is mounted in another with `route()`, Hono passes one context through both, so the first Routa
 * app identifies the request and the app it mounts reuses that identity, when both apps have the
 * same correlation setting.
 */
const identified = new WeakMap<Context, TrackedRequest>();

/** What Hono's error says when nothing on the app returned a response or called `next()`. */
const unansweredMessage =
	"Context is not finalized. Did you forget to return a Response object or `await next()`?";

/**
 * Gives every request that reaches the app its identity, before anything else runs: a generated
 * UUID, the caller's correlation ID when the configured header carries a valid one, and a request
 * logger bound to both. Once the response is prepared, it sets `x-request-id` last, over any value
 * something else wrote, echoes an accepted correlation ID or removes the correlation header when
 * it accepted none, and logs `http.response.prepared`.
 *
 * The first Routa app a request reaches owns its identity. A Routa app mounted in it reuses that
 * identity, with its own request logger, and leaves the headers and the event to the owner, so
 * handlers, headers, and the one event agree. Each app checks its correlation header against its
 * own credential schemes and declared headers, so a mounted app reuses the identity only when its
 * correlation setting is the owner's. Otherwise it refuses every request it answers: it takes
 * the correlation ID out of the shared identity, so the owner neither echoes nor logs it, and
 * answers Routa's internal `500`, which it logs and reports as a `configuration_error`.
 *
 * Routa writes these headers in place only on a response it prepared for this request. Any other
 * response, such as one a handler added to the returned Hono app reuses across requests, or one
 * whose headers are immutable, is copied first, so one request's identity never reaches another's.
 * A response the runtime cannot copy, such as a `101` upgrade response, is returned as it is,
 * without identity headers, and its event still logs its status.
 *
 * When nothing on the app answers a request, Hono fails it only after the whole chain returns,
 * where Routa cannot identify the response. The owner raises the same error inside the chain
 * instead, once every middleware on it, including any app mounted in it, has had its chance to
 * answer, so Hono's error handler, or one the application set with `onError`, answers it there
 * and the answer carries the identity. A mounted Routa app leaves this to the owner.
 *
 * The event says the response was prepared, not that it was sent or received: Routa logs it
 * before the body is transmitted. A request whose handling throws past Hono logs nothing.
 *
 * @returns `answer` records the route pattern that matched a request, calls `respond` with this
 *   app's state for it, and records the response Routa prepared
 */
function identifyRequests(
	app: Hono,
	logger: RoutaLogger,
	correlationHeader: string | undefined,
	report: ReportRequestError | undefined,
): {
	answer: (
		context: Context,
		path: string,
		respond: (state: RequestState) => Response | Promise<Response>,
	) => Promise<Response>;
} {
	const deriveLogger = requestLoggers(logger);
	// This app's view of each request: its identity, and this app's request logger.
	const states = new WeakMap<Context, RequestState>();
	// The requests whose identity this app owns.
	const owned = new WeakSet<Context>();
	// The requests an app with another correlation setting identified, which this app refuses.
	const refused = new WeakSet<Context>();
	const stateFor = ({ requestId, correlationId }: RequestIdentity): RequestState => ({
		requestId,
		...(correlationId !== undefined && { correlationId }),
		// Both names are bound on every request, `correlationId` without a value when none was
		// accepted, so no binding of the configured logger and no event data can supply either.
		...deriveLogger({ requestId, correlationId }),
	});

	app.use(
		"*",
		async (context, next) => {
			const owner = identified.get(context);

			if (owner) {
				if (owner.correlationHeader === correlationHeader) {
					states.set(context, stateFor(owner));
				} else {
					refused.add(context);
					states.set(context, stateFor({ requestId: owner.requestId }));
				}

				await next();
				return;
			}

			const startedAt = performance.now();
			const requestId = crypto.randomUUID();
			const correlationId =
				correlationHeader === undefined
					? undefined
					: acceptedCorrelation(context.req.raw.headers, correlationHeader);
			const request: TrackedRequest = {
				requestId,
				...(correlationId !== undefined && { correlationId }),
				correlationHeader,
			};
			const state = stateFor(request);
			identified.set(context, request);
			states.set(context, state);
			owned.add(context);

			await next();

			if (context.res === request.prepared || adoptResponse(context)) {
				const { headers } = context.res;
				headers.set(requestIdHeader, requestId);

				// Routa owns the configured correlation header, so a response never presents a value
				// Routa did not accept, such as one a handler forwarded from upstream. No other header
				// Routa writes can be the correlation header, and no other header is touched.
				if (correlationHeader !== undefined) {
					if (request.correlationId === undefined) {
						headers.delete(correlationHeader);
					} else {
						headers.set(correlationHeader, request.correlationId);
					}
				}
			}

			// A mounted app that refused the request took its correlation ID out of the identity.
			const logged = request.correlationId === correlationId ? state : stateFor(request);
			logged.event("info", "http.response.prepared", "Response prepared.", {
				method: loggedMethod(context.req.raw.method),
				route: request.route ?? unmatchedRoute,
				status: context.res.status,
				durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
			});
		},
		async (context, next) => {
			await next();

			// Reading `context.res` here would make Hono create a placeholder 200 response.
			if (owned.has(context) && !context.finalized) {
				throw new Error(unansweredMessage);
			}
		},
	);

	const tracked = (context: Context) => {
		const request = identified.get(context);
		const state = states.get(context);

		if (!request || !state) {
			throw new Error("Routa received a request its identity middleware did not see.");
		}

		return { request, state };
	};

	const refuse = (context: Context, request: TrackedRequest, state: RequestState) => {
		delete request.correlationId;
		const diagnostic: RequestErrorDiagnostic = Object.freeze({
			code: "configuration_error",
			stage: "identity",
			requestId: request.requestId,
			method: loggedMethod(context.req.raw.method),
			route: request.route ?? unmatchedRoute,
			status: 500,
		});

		try {
			logRequestError(state.event, diagnostic, undefined);
		} catch {
			// A failing logger must not skip reporting or replace the error response.
		}

		report?.(
			new Error(
				`A Routa app ${correlationSetting(correlationHeader)} is mounted in a Routa app ${correlationSetting(request.correlationHeader)}. Routa checks each app's credential schemes and declared headers against its own correlation header, so a mounted Routa app must have the same correlation setting as the app it is mounted in.`,
			),
			diagnostic,
		);
		return internalErrorResponse();
	};

	return {
		answer: async (context, path, respond) => {
			const { request, state } = tracked(context);
			request.route = path;
			const response = refused.has(context)
				? refuse(context, request, state)
				: await respond(state);
			request.prepared = response;
			return response;
		},
	};
}

/** Describes an app's correlation setting by its header, for a configuration error. */
function correlationSetting(header: string | undefined): string {
	return header === undefined ? "with correlation off" : `that correlates on ${header}`;
}

/**
 * Replaces a response Routa did not prepare with a copy whose headers Routa may write.
 *
 * @returns `false`, leaving the response as it is, when the runtime cannot copy it: the
 *   `Response` constructor accepts only statuses 200 to 599, so a `101` upgrade response a
 *   runtime built itself has no copy
 */
function adoptResponse(context: Context): boolean {
	let copy: Response;

	try {
		copy = new Response(context.res.body, context.res);
	} catch {
		return false;
	}

	context.res = copy;
	return true;
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
	correlationHeader: string | undefined,
	logger: RoutaLogger,
): void {
	const label = `${method.toUpperCase()} ${path}`;
	const owned = {
		lifecycle: lifecycleOwnedHeaders(contract.deprecation, lifecycleHeaders),
		correlation: correlationHeader,
	};

	for (const [name, outcome] of Object.entries(contract.responses)) {
		const problem = outcomeProblem(outcome, method, owned);

		if (problem) {
			throw new Error(`Outcome "${name}" on ${label} ${problem}`);
		}

		warnCookieScopes(logger, `Outcome "${name}" on ${label}`, outcome);
	}

	for (const item of contract.middleware ?? []) {
		for (const [name, outcome] of Object.entries(item.rejects ?? {}) as Array<
			[string, { status: number; schema?: unknown; headers?: unknown; cookies?: unknown }]
		>) {
			const problem = outcomeProblem(outcome, method, owned);

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
	owned: OwnedHeaders,
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
		const problem = headerDeclarationProblem(outcome.headers, owned);

		if (problem) {
			return problem;
		}
	}

	if (outcome.cookies !== undefined) {
		return cookieDeclarationProblem(outcome.cookies);
	}

	return undefined;
}

/** What Routa reserves each context key for, which no middleware can provide. */
const reservedProvides: Readonly<Record<string, string>> = {
	services: "injected services",
	requestId: "request identity",
	correlationId: "request identity",
	logger: "the request logger",
};

/**
 * Rejects middleware that provides `ctx.services`, `ctx.requestId`, `ctx.correlationId`, or
 * `ctx.logger`, which Routa reserves, or `ctx.auth` when authentication is configured. TypeScript
 * and `routa check` report the same rules; this covers contracts typed through `any`.
 */
function assertReservedContext(
	contract: RuntimeRouteContract,
	label: string,
	authenticated: boolean,
): void {
	for (const [index, item] of (contract.middleware ?? []).entries()) {
		for (const [key, owner] of Object.entries(reservedProvides)) {
			if (item.provides && Object.hasOwn(item.provides, key)) {
				throw new Error(
					`middleware[${index}] on ${label} provides ctx.${key}, which Routa reserves for ${owner}. Rename the provided key.`,
				);
			}
		}

		if (authenticated && item.provides && Object.hasOwn(item.provides, "auth")) {
			throw new Error(
				`middleware[${index}] on ${label} provides ctx.auth, which Routa reserves for authentication. Rename the provided key.`,
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

	if ((route.contract as { services?: unknown }).services !== undefined && !method) {
		throw new Error(
			`The contract on ${label} declares services, but the route supplies no method services declaration, so its factory would never run.`,
		);
	}
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
	authentication: RouteAuthentication | undefined,
): void {
	const seen = new Map<string, string>(
		Object.keys(contract.responses).map((type) => [type, "the route"]),
	);
	// Routa owns the authentication outcomes. Every requireAuth guard shares one.
	const framework = [
		...(authentication ? ["authenticationFailed"] : []),
		...(authentication && rejectsAmbiguousCredentials(authentication)
			? ["ambiguousCredentials"]
			: []),
		...((contract.middleware ?? []).some(isAuthenticationGuard) ? ["authenticationRequired"] : []),
	];

	for (const type of framework) {
		const previous = seen.get(type);

		if (previous) {
			throw new Error(
				`Outcome "${type}" on ${method} ${path} is declared by ${previous} and by Routa authentication. Give each outcome its own name.`,
			);
		}

		seen.set(type, "Routa authentication");
	}

	for (const [index, item] of (contract.middleware ?? []).entries()) {
		const label = `middleware[${index}]`;

		if (isAuthenticationGuard(item)) {
			continue;
		}

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
