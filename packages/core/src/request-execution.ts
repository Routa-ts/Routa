import { ZodError, type z } from "zod";
import type { AnyRouteContract, MiddlewareContract, RouteInput } from "./index.js";
import { type HandlerOutputIssue, InvalidHandlerOutputError } from "./handler-output-error.js";
import type { RoutaLogger } from "./logger.js";
import {
	type CookieEntry,
	planCookies,
	resolveCookieEffects,
	serializeCookieEffect,
} from "./response-cookies.js";
import { lifecycleHeaders, resolveHeaders, serializeHeaders } from "./response-headers.js";

type RuntimeResult = {
	type: string;
	data?: unknown;
};

type RuntimeOutcome = {
	status: number;
	description?: string;
	schema?: z.ZodTypeAny;
	headers?: z.ZodTypeAny;
	cookies?: readonly unknown[];
};

/**
 * A validated handler result: either a JSON body or an intentionally empty body, with the
 * serialized response headers and cookies its outcome declared.
 */
type ValidatedResult = {
	status: number;
	headers: ReadonlyArray<readonly [string, string]>;
	cookies: readonly CookieEntry[];
} & ({ body: false } | { body: true; data: unknown });

export type RuntimeRouteContract = AnyRouteContract & {
	run: (args: {
		input: Record<string, unknown>;
		ctx: Record<string, unknown>;
		response: Readonly<Record<string, (...args: unknown[]) => RuntimeResult>>;
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

			return finalizeResponse(
				response,
				lifecycleHeaders(contract.deprecation, options.lifecycleHeaders),
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
			const response = Object.create(null) as Record<string, (...args: unknown[]) => RuntimeResult>;
			for (const [type, outcome] of Object.entries(contract.responses)) {
				response[type] = (...args) => buildResult(type, outcome, args);
			}
			const result = await contract.run({
				input: routeInput,
				ctx: { ...ctx, logger },
				response: Object.freeze(response),
			});

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

/**
 * Builds a handler result from a builder call: a body outcome takes `(data, headers?)`, a bodyless
 * outcome takes `(headers?)`.
 */
function buildResult(
	type: string,
	outcome: RuntimeOutcome,
	args: readonly unknown[],
): RuntimeResult & { headers?: unknown } {
	const [data, headers] = outcome.schema ? args : [undefined, args[0]];

	return {
		type,
		...(outcome.schema && args.length > 0 ? { data } : {}),
		...(headers === undefined ? {} : { headers }),
	};
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
 * Structural checks (known outcome, data presence, transport safety) always run.
 * Zod parsing is gated by `validateResponse`. It only checks that the handler value is
 * valid and unchanged: the handler value is always what gets sent, never the parsed one.
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
): ValidatedResult {
	if (!isRuntimeResult(result)) {
		throw new InvalidHandlerOutputError("Handler returned invalid output.");
	}

	const response = declaredOutcome(contract, result.type);

	if (!response) {
		throw new InvalidHandlerOutputError(`Handler returned unknown response type "${result.type}".`);
	}

	const headers = validatedHeaders(result, response, validateResponse);
	const cookies = validatedCookies(result, response, validateResponse);

	if (!response.schema) {
		if (result.data !== undefined) {
			throw new InvalidHandlerOutputError(
				`Response type "${result.type}" declares no schema and cannot return data.`,
			);
		}

		return { body: false, status: response.status, headers, cookies };
	}

	if (!("data" in result)) {
		throw new InvalidHandlerOutputError(
			`Response type "${result.type}" declares a schema and requires data.`,
		);
	}

	if (isBodylessStatus(response.status)) {
		throw new InvalidHandlerOutputError(
			`Response type "${result.type}" uses status ${response.status}, which cannot have a body.`,
		);
	}

	if (validateResponse) {
		try {
			// Zod can hand back references shared with the handler value, so a refinement may
			// mutate both. Compare against a copy taken before parsing.
			const snapshot = jsonSnapshot(result.data);

			assertUnchanged(parseSchema(response.schema, result.data), snapshot);
			assertUnchanged(result.data, snapshot);
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

	return { body: true, data: result.data, status: response.status, headers, cookies };
}

/**
 * Checks and serializes the headers a result writes for its outcome.
 *
 * Declared names, required presence, and safe serialization are checked in every mode. Zod parsing
 * and the comparison with the handler value follow `validateResponse`, like the body.
 */
function validatedHeaders(
	result: RuntimeResult & { headers?: unknown },
	outcome: RuntimeOutcome,
	validateResponse: boolean,
): ReadonlyArray<readonly [string, string]> {
	const values = resolveHeaders(result.type, outcome, result.headers);
	const serialized = serializeHeaders(result.type, outcome, values);

	if (validateResponse && outcome.headers) {
		try {
			assertUnchanged(parseSchema(outcome.headers, values), { ...values }, ["headers"]);
		} catch (error) {
			if (error instanceof ZodError) {
				throw new InvalidHandlerOutputError(
					"Handler returned response headers that do not match schema.",
					handlerOutputIssues(error, ["headers"]),
				);
			}

			throw error;
		}
	}

	return serialized;
}

/**
 * Checks and serializes the cookie effects a result writes for its outcome.
 *
 * Declared handles, one effect per identity, and safe encoding are checked in every mode. Zod
 * parsing and the comparison with the handler value follow `validateResponse`, like the body.
 * Route outcomes and terminal middleware rejects both come through here, so they share one path.
 */
function validatedCookies(
	result: RuntimeResult & { cookies?: unknown },
	outcome: RuntimeOutcome,
	validateResponse: boolean,
): readonly CookieEntry[] {
	return resolveCookieEffects(result.type, outcome, result.cookies).map((effect) => {
		const entry = serializeCookieEffect(result.type, effect, `outcome "${result.type}"`);

		if (validateResponse && effect.kind === "set") {
			try {
				assertUnchanged(parseSchema(effect.cookie.schema, effect.value), effect.value, [
					"cookies",
					effect.cookie.name,
				]);
			} catch (error) {
				if (error instanceof ZodError) {
					throw new InvalidHandlerOutputError(
						"Handler returned a cookie value that does not match schema.",
						handlerOutputIssues(error, ["cookies", effect.cookie.name]),
					);
				}

				throw error;
			}
		}

		return entry;
	});
}

function declaredOutcome(contract: RuntimeRouteContract, type: string): RuntimeOutcome | undefined {
	if (Object.hasOwn(contract.responses, type)) {
		return contract.responses[type];
	}

	return middlewareResponses(contract)[type];
}

/** Copies a value through JSON, the representation that would go on the wire. */
function jsonSnapshot(value: unknown): unknown {
	let text: string | undefined;

	try {
		text = JSON.stringify(value);
	} catch (error) {
		throw new InvalidHandlerOutputError(
			`Failed to serialize response as JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	if (text === undefined) {
		throw new InvalidHandlerOutputError("Response data cannot be serialized as JSON.");
	}

	return JSON.parse(text);
}

/**
 * Fails when parsing changed the handler value, so a mutating schema is caught in
 * development instead of silently producing a different body in production.
 */
function assertUnchanged(
	parsed: unknown,
	original: unknown,
	root: readonly PropertyKey[] = [],
): void {
	const path = firstChange(parsed, original, root);

	if (path) {
		throw new InvalidHandlerOutputError(
			`Handler returned response ${root[0] === "headers" ? "headers" : root[0] === "cookies" ? "cookies" : "data"} that its schema would change. Response schemas must not change values.`,
			[{ code: "response_value_changed", path }],
		);
	}
}

/** Returns the path of the first difference between two JSON-like values, if any. */
function firstChange(
	parsed: unknown,
	original: unknown,
	path: readonly PropertyKey[],
): readonly PropertyKey[] | undefined {
	const left = toJsonValue(parsed);
	const right = toJsonValue(original);

	if (Array.isArray(left) && Array.isArray(right)) {
		if (left.length !== right.length) {
			return path;
		}

		for (const [index, item] of left.entries()) {
			const change = firstChange(item, right[index], [...path, index]);

			if (change) {
				return change;
			}
		}

		return undefined;
	}

	if (isPlainObject(left) && isPlainObject(right)) {
		const keys = new Set([...definedKeys(left), ...definedKeys(right)]);

		for (const key of keys) {
			const change = firstChange(left[key], right[key], [...path, key]);

			if (change) {
				return change;
			}
		}

		return undefined;
	}

	return Object.is(left, right) || left === right ? undefined : path;
}

/** Applies `toJSON` so dates and similar values compare as they would on the wire. */
function toJsonValue(value: unknown): unknown {
	if (
		typeof value === "object"
		&& value !== null
		&& "toJSON" in value
		&& typeof value.toJSON === "function"
	) {
		return value.toJSON();
	}

	return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Keys that survive JSON serialization. */
function definedKeys(value: Record<string, unknown>): string[] {
	return Object.keys(value).filter((key) => value[key] !== undefined);
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

function middlewareResponses(contract: RuntimeRouteContract): Record<string, RuntimeOutcome> {
	const responses: Record<string, RuntimeOutcome> = Object.create(null);

	for (const item of contract.middleware ?? []) {
		for (const [type, response] of Object.entries(item.rejects ?? {}) as Array<
			[string, RuntimeOutcome]
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
 * @returns `true` if the value is a non-null object with a string `type` property, `false` otherwise.
 */
function isRuntimeResult(value: unknown): value is RuntimeResult {
	return (
		typeof value === "object" && value !== null && "type" in value && typeof value.type === "string"
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
 * The one place a handled outcome becomes a `Response`.
 *
 * It combines the transport headers Routa owns (`content-type` for a JSON body, none for a bodyless
 * outcome), the outcome's declared headers, the lifecycle headers, and the cookie plan, which
 * becomes repeated `Set-Cookie` fields. A header has one owner:
 * a declared header that a lifecycle header or a transport header also claims fails instead of
 * overwriting.
 *
 * @param response - The validated outcome, with its serialized declared headers
 * @param lifecycle - Lifecycle headers for the route, keyed by lowercase name
 * @throws {InvalidHandlerOutputError} When two owners claim one header
 */
function finalizeResponse(
	response: ValidatedResult,
	lifecycle: Readonly<Record<string, string>>,
): Response {
	const headers = new Headers();

	for (const [name, value] of response.headers) {
		if (Object.hasOwn(lifecycle, name) || headers.has(name)) {
			throw new InvalidHandlerOutputError(
				`Header "${name}" has more than one owner, so Routa will not overwrite it.`,
			);
		}

		headers.set(name, value);
	}

	for (const [name, value] of Object.entries(lifecycle)) {
		headers.set(name, value);
	}

	for (const field of planCookies(response.cookies)) {
		headers.append("set-cookie", field);
	}

	return response.body
		? json(response.data, response.status, headers)
		: new Response(null, { status: response.status, headers });
}

/**
 * Creates a JSON response.
 *
 * @param data - The response body to serialize as JSON
 * @param status - The HTTP status code for the response
 * @returns A `Response` with a JSON body and `application/json; charset=utf-8` content type
 */
function json(data: unknown, status: number, headers: HeadersInit = {}): Response {
	let body: string | undefined;

	try {
		body = JSON.stringify(data);
	} catch (error) {
		throw new InvalidHandlerOutputError(
			`Failed to serialize response as JSON: ${error instanceof Error ? error.message : String(error)}`,
		);
	}

	if (body === undefined) {
		throw new InvalidHandlerOutputError("Response data cannot be serialized as JSON.");
	}

	const responseHeaders = new Headers(headers);
	responseHeaders.set("content-type", "application/json; charset=utf-8");

	return new Response(body, { status, headers: responseHeaders });
}

/**
 * Determines whether HTTP forbids a response body for a status (204, 205, and 304).
 *
 * This describes the status only. An outcome without a `schema` is also bodyless, whatever its status.
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

class InvalidJsonBodyError extends Error {}

class UnsupportedMediaTypeError extends Error {}
