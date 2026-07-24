import { type Context, Hono } from "hono";
import { ZodError, type z } from "zod";
import type { AnyRouteContract, HttpMethod, MiddlewareContract, RouteInput } from "./index.js";
import { createLogger, type RoutaLogger } from "./logger.js";

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
	lifecycleHeaders?: boolean;
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

		assertUniqueMiddlewareRejects(contract, route.path, method);

		const methods = methodsByPath.get(route.path) ?? new Set<string>();
		methods.add(method);
		methodsByPath.set(route.path, methods);

		const honoMethod = route.method === "head" ? "GET" : method;

		app.on(honoMethod, route.path, async (context, next) => {
			if (route.method === "head" && context.req.raw.method !== "HEAD") {
				return await next();
			}

			try {
				if (!acceptsJson(context.req.raw)) {
					return new Response("Not Acceptable", { status: 406 });
				}

				const inputReader = new RequestInputReader(context);
				const input = await inputReader.parse(contract.input);
				const ctx = toRecord(route.createContext ? await route.createContext() : {});
				const result = await runWithMiddleware(contract, input, ctx, inputReader, routeLogger);
				const response = validateResult(contract, result);

				return json(response.data, response.status, lifecycleHeaders(contract, options));
			} catch (error) {
				const response = errorResponse(error);
				logRequestError(options.logger, context, error, response);
				return response;
			}
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
	logger: RoutaLogger,
): Promise<RuntimeResult> {
	const middleware = contract.middleware ?? [];

	async function dispatch(index: number): Promise<RuntimeResult> {
		const item = middleware[index];

		if (!item) {
			// Framework-owned context is applied last so middleware or a low-level
			// createContext implementation cannot replace the configured logger.
			const result = await contract.run({ input: routeInput, ctx: { ...ctx, logger } });

			if (isRuntimeResult(result)) {
				return result;
			}

			throw new InvalidHandlerOutputError("Handler returned invalid output.");
		}

		if (!item.run) {
			return await dispatch(index + 1);
		}

		assertMiddlewareRequires(item.requires, ctx);

		let nextCalled = false;
		const input = await inputReader.parse(item.input);
		const result = await item.run({
			input,
			ctx,
			/**
			 * Continues the middleware chain. Callers must `await next(...)` (or return its
			 * promise). Fire-and-forget `next()` without awaiting drops the downstream result
			 * and can leave the request hanging or returning invalid middleware output.
			 */
			next: async (providedCtx = {}) => {
				if (nextCalled) {
					throw new Error("Middleware next() called multiple times.");
				}

				nextCalled = true;
				Object.assign(ctx, parseMiddlewareProvides(item.provides, providedCtx));
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

	if (!isJsonMediaType(contentType)) {
		throw problem(
			"https://routa-ts.dev/problems/unsupported-media-type",
			"Unsupported Media Type",
			415,
		);
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
 * Ensures middleware required context keys are present before the middleware runs.
 *
 * @param requires - Context keys declared by the middleware
 * @param ctx - Shared request context
 */
function assertMiddlewareRequires(
	requires: readonly string[] | undefined,
	ctx: Record<string, unknown>,
): void {
	for (const key of requires ?? []) {
		if (!(key in ctx)) {
			throw new Error(`Middleware requires ctx.${key}, but it was not provided.`);
		}
	}
}

/**
 * Validates context values provided by middleware against declared Zod schemas.
 *
 * @param provides - Middleware `provides` schemas
 * @param providedCtx - Context values passed to `next()`
 * @returns The provided context with schema-validated `provides` values
 */
function parseMiddlewareProvides(
	provides: Record<string, z.ZodTypeAny> | undefined,
	providedCtx: Record<string, unknown>,
): Record<string, unknown> {
	if (!provides) {
		return providedCtx;
	}

	const validated: Record<string, unknown> = { ...providedCtx };

	try {
		for (const [key, schema] of Object.entries(provides)) {
			validated[key] = parseSchema(schema, providedCtx[key]);
		}
	} catch (error) {
		if (error instanceof ZodError) {
			throw new InvalidHandlerOutputError(
				"Middleware provided context that does not match schema.",
			);
		}

		throw error;
	}

	return validated;
}

/**
 * Parses cookies from the request header.
 *
 * Values are `decodeURIComponent`'d when possible; malformed percent-encoding is
 * kept as the raw cookie value so parsing never throws.
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

			return [[key, decodeCookieValue(item.slice(index + 1).trim())]];
		}),
	);
}

/**
 * Decodes a cookie value with `decodeURIComponent`, falling back to the raw
 * string when the value contains malformed percent-encoding.
 */
function decodeCookieValue(value: string): string {
	try {
		return decodeURIComponent(value);
	} catch {
		return value;
	}
}

function parseMediaRanges(header: string): Array<{ type: string; subtype: string; q: number }> {
	return header.split(",").flatMap((item) => {
		const [mediaRange, ...parameters] = item.split(";").map((part) => part.trim());
		const [type, subtype] = mediaRange.toLowerCase().split("/");

		if (!type || !subtype) {
			return [];
		}

		const qParameter = parameters.find((parameter) => parameter.toLowerCase().startsWith("q="));
		const q = qParameter ? Number(qParameter.slice(2)) : 1;

		if (!Number.isFinite(q) || q < 0 || q > 1) {
			return [];
		}

		return [{ type, subtype, q }];
	});
}

function isJsonMediaType(value: string): boolean {
	return parseMediaRanges(value).some(
		({ type, subtype }) =>
			type === "application" && (subtype === "json" || subtype.endsWith("+json")),
	);
}

function acceptsJson(request: Request): boolean {
	const accept = request.headers.get("accept");

	if (!accept) {
		return true;
	}

	const matches = parseMediaRanges(accept)
		.map((range, index) => ({
			...range,
			index,
			specificity: jsonAcceptSpecificity(range.type, range.subtype),
		}))
		.filter((range) => range.specificity >= 0)
		.sort((left, right) => {
			if (right.specificity !== left.specificity) {
				return right.specificity - left.specificity;
			}

			if (right.q !== left.q) {
				return right.q - left.q;
			}

			return left.index - right.index;
		});

	return (matches[0]?.q ?? 0) > 0;
}

/**
 * Scores how specifically an Accept media range matches JSON responses.
 *
 * Higher scores win during negotiation. `application/json` is most specific,
 * then `application/` + `*+json`, then `application/` + `*`, then `*` + `/` + `*`.
 */
function jsonAcceptSpecificity(type: string, subtype: string): number {
	if (type === "application" && subtype === "json") {
		return 3;
	}

	if (type === "application" && subtype.endsWith("+json")) {
		return 2;
	}

	if (type === "application" && subtype === "*") {
		return 1;
	}

	if (type === "*" && subtype === "*") {
		return 0;
	}

	return -1;
}

function problem(
	type: string,
	title: string,
	status: number,
	extra?: Record<string, unknown>,
): Response {
	return json(
		{
			type,
			title,
			status,
			...(extra ?? {}),
		},
		status,
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

	const response = contract.responses[result.type] ?? middlewareResponses(contract)[result.type];

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

function middlewareResponses(
	contract: RuntimeRouteContract,
): Record<string, { status: number; schema: z.ZodTypeAny }> {
	const responses: Record<string, { status: number; schema: z.ZodTypeAny }> = {};

	for (const item of contract.middleware ?? []) {
		for (const [type, response] of Object.entries(item.rejects ?? {}) as Array<
			[string, { status: number; schema: z.ZodTypeAny }]
		>) {
			responses[type] = response;
		}
	}

	return responses;
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
 * @returns The value as a record when it is a non-array object
 * @throws {InvalidHandlerOutputError} When the value is not a plain object
 */
function toRecord(value: unknown): Record<string, unknown> {
	if (typeof value === "object" && value !== null && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}

	throw new InvalidHandlerOutputError(
		`createContext() must return a plain object, received ${value === null ? "null" : Array.isArray(value) ? "array" : typeof value}.`,
	);
}

/**
 * Creates a JSON response.
 *
 * Statuses that forbid a body (204, 205, 304) produce an empty response because
 * the `Response` constructor throws when given a body for those statuses.
 *
 * @param data - The response body to serialize as JSON
 * @param status - The HTTP status code for the response
 * @returns A `Response` with a JSON body and `application/json; charset=utf-8` content type
 */
function json(data: unknown, status: number, headers: HeadersInit = {}): Response {
	if (isBodylessStatus(status)) {
		return new Response(null, { status, headers });
	}

	let body: string;

	try {
		body = JSON.stringify(data);
	} catch (error) {
		throw new InvalidHandlerOutputError(
			`Failed to serialize response as JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	return new Response(body, {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			...headers,
		},
	});
}

function lifecycleHeaders(
	contract: RuntimeRouteContract,
	options: CreateHonoAppOptions,
): HeadersInit {
	if (!options.lifecycleHeaders || !contract.deprecation) return {};
	return {
		Deprecation: "true",
		...(contract.deprecation.sunset ? { Sunset: contract.deprecation.sunset } : {}),
		...(contract.deprecation.replacement
			? { Link: `<${contract.deprecation.replacement}>; rel="successor-version"` }
			: {}),
	};
}

/**
 * Determines whether an HTTP status forbids a response body.
 */
export function isBodylessStatus(status: number): boolean {
	return status === 204 || status === 205 || status === 304;
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
		return problem("https://routa-ts.dev/problems/handler-output", "Invalid handler output", 500);
	}

	if (error instanceof InvalidJsonBodyError) {
		return problem("https://routa-ts.dev/problems/invalid-json", "Invalid JSON body", 400);
	}

	if (error instanceof ZodError) {
		return problem("https://routa-ts.dev/problems/validation", "Validation failed", 400, {
			issues: error.issues.map((issue) => ({
				path: issue.path,
				message: issue.message,
			})),
		});
	}

	return problem("https://routa-ts.dev/problems/internal", "Internal Server Error", 500);
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
