import { ZodError, type z } from "zod";
import type { AnyRouteContract, MiddlewareContract, RouteInput } from "./index.js";
import type { RoutaLogger } from "./logger.js";

type RuntimeResult = {
	type: string;
	data: unknown;
};

type HandlerOutputIssue = {
	code: string;
	path: readonly PropertyKey[];
};

export type RuntimeRouteContract = AnyRouteContract & {
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

type RequestExecutorOptions = {
	logger: RoutaLogger;
	validateResponses: boolean;
	lifecycleHeaders?: boolean;
	requestLogger?: RoutaLogger;
	createContext?: () => unknown | Promise<unknown>;
};

type RequestExecutor = (request: Request, params: Record<string, string>) => Promise<Response>;

/** Prepares a route's execution pipeline independently of Hono registration. */
export function createRequestExecutor(
	contract: RuntimeRouteContract,
	options: RequestExecutorOptions,
): RequestExecutor {
	return async (request, params) => {
		try {
			if (!acceptsJson(request)) {
				return new Response("Not Acceptable", { status: 406 });
			}

			const inputReader = new RequestInputReader(request, params);
			const input = await inputReader.parse(contract.input);
			const ctx = toRecord(options.createContext ? await options.createContext() : {});
			const result = await runWithMiddleware(contract, input, ctx, inputReader, options.logger);
			const response = validateResult(contract, result, options.validateResponses);

			return json(
				response.data,
				response.status,
				lifecycleHeaders(contract, options.lifecycleHeaders),
			);
		} catch (error) {
			const response = errorResponse(error);
			logRequestError(options.requestLogger, request, error, response);
			return response;
		}
	};
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

	constructor(
		private readonly request: Request,
		private readonly params: Record<string, string>,
	) {}

	async parse(input: RouteInput | undefined) {
		if (!input) {
			return {};
		}

		const request = this.request;
		const url = new URL(request.url);

		return {
			...(input.params ? { params: parseSchema(input.params, this.params) } : {}),
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

		this.bodyValue = await parseBody(this.request);
		this.bodyParsed = true;
		return this.bodyValue;
	}
}

/**
 * Parses a JSON request body.
 *
 * @param request - The incoming request
 * @returns The parsed JSON value
 * @throws {UnsupportedMediaTypeError} When the request content type is not JSON
 * @throws {InvalidJsonBodyError} When the body cannot be parsed as JSON
 */
async function parseBody(request: Request): Promise<unknown> {
	const contentType = request.headers.get("content-type") ?? "";

	if (!isJsonMediaType(contentType)) {
		throw new UnsupportedMediaTypeError();
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
 * @returns Parsed declared values; context keys absent from `provides` are omitted
 */
function parseMiddlewareProvides(
	provides: Record<string, z.ZodTypeAny> | undefined,
	providedCtx: Record<string, unknown>,
): Record<string, unknown> {
	const validated: Record<string, unknown> = {};

	for (const [key, schema] of Object.entries(provides ?? {})) {
		try {
			validated[key] = parseSchema(schema, providedCtx[key]);
		} catch (error) {
			if (error instanceof ZodError) {
				throw new InvalidHandlerOutputError(
					"Middleware provided context that does not match schema.",
					handlerOutputIssues(error, [key]),
				);
			}

			throw error;
		}
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
 * @param validateResponse - Whether to parse response data through its declared schema.
 * @returns A validated runtime result with the corresponding HTTP status.
 */
function validateResult(
	contract: RuntimeRouteContract,
	result: unknown,
	validateResponse: boolean,
): RuntimeResult & { status: number } {
	if (!isRuntimeResult(result)) {
		throw new InvalidHandlerOutputError("Handler returned invalid output.");
	}

	const response = contract.responses[result.type] ?? middlewareResponses(contract)[result.type];

	if (!response) {
		throw new InvalidHandlerOutputError(`Handler returned unknown response type "${result.type}".`);
	}

	if (!validateResponse) {
		return {
			type: result.type,
			data: result.data,
			status: response.status,
		};
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
				handlerOutputIssues(error),
			);
		}

		throw error;
	}
}

function handlerOutputIssues(
	error: ZodError,
	prefix: readonly PropertyKey[] = [],
): HandlerOutputIssue[] {
	return error.issues.map((issue) => ({
		code: issue.code,
		path: [...prefix, ...issue.path],
	}));
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
	includeLifecycleHeaders?: boolean,
): HeadersInit {
	if (!includeLifecycleHeaders || !contract.deprecation) return {};
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
 * @returns A response that maps known error types to problem JSON responses.
 */
function errorResponse(error: unknown): Response {
	if (error instanceof InvalidHandlerOutputError) {
		return problem("https://routa-ts.dev/problems/handler-output", "Invalid handler output", 500);
	}

	if (error instanceof InvalidJsonBodyError) {
		return problem("https://routa-ts.dev/problems/invalid-json", "Invalid JSON body", 400);
	}

	if (error instanceof UnsupportedMediaTypeError) {
		return problem(
			"https://routa-ts.dev/problems/unsupported-media-type",
			"Unsupported Media Type",
			415,
		);
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
 * @param request - The incoming request.
 * @param error - The error associated with the failure.
 * @param response - The response returned for the request.
 */
function logRequestError(
	logger: RoutaLogger | undefined,
	request: Request,
	error: unknown,
	response: Response,
): void {
	if (!logger || response.status < 500) {
		return;
	}

	const url = new URL(request.url);
	const data = {
		method: request.method,
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
			...(error instanceof InvalidHandlerOutputError && error.issues
				? { issues: error.issues }
				: {}),
		};
	}

	return {
		error: String(error),
	};
}

class InvalidHandlerOutputError extends Error {
	constructor(
		message: string,
		readonly issues?: readonly HandlerOutputIssue[],
	) {
		super(message);
	}
}

class InvalidJsonBodyError extends Error {}

class UnsupportedMediaTypeError extends Error {}
