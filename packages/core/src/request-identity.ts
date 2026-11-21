import type { RuntimeAuthentication } from "./authentication.js";
import type { RoutaLogger } from "./logger.js";
import type { FrameworkEvent } from "./logger-registry.js";
import { reservedHeaders } from "./response-headers.js";

/** The response header that carries Routa's generated request identity. */
export const requestIdHeader = "x-request-id";

/** The correlation header `correlation: true` reads and echoes. */
export const defaultCorrelationHeader = "x-correlation-id";

/** The `route` that framework events log for a request no route path matched. */
export const unmatchedRoute = "[Unmatched]";

/** One request's identity: the ID Routa generated, and the caller's correlation ID if accepted. */
export type RequestIdentity = {
	readonly requestId: string;
	readonly correlationId?: string;
};

/** What Routa keeps for one request: its identity and its request logger. */
export type RequestState = RequestIdentity & {
	/** The configured logger's child, bound to the identity so no event or child replaces it. */
	readonly logger: RoutaLogger;
	/** Writes Routa's own events through `logger`, so no application binding crowds out their fields. */
	readonly event: FrameworkEvent;
};

/** One value of 1 to 128 ASCII letters, digits, dots, underscores, and hyphens. */
const correlationValue = /^[A-Za-z0-9._-]{1,128}$/;

/** RFC 9110 `token`, the grammar of header names. */
const headerName = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

const credentialHeaders: ReadonlySet<string> = new Set([
	"authorization",
	"proxy-authorization",
	"cookie",
	"set-cookie",
]);

/**
 * Headers Routa writes itself, and who writes each. The echo would replace one, so none can be
 * the correlation header. Headers that authentication schemes or outcomes declare are checked
 * with those declarations.
 */
const routaHeaders: ReadonlyMap<string, string> = new Map([
	...reservedHeaders.map((name) => [name, "Routa owns on every response"] as const),
	["allow", "Routa sets on automatic OPTIONS and 405 responses"],
	["access-control-allow-methods", "Routa sets on automatic OPTIONS responses"],
	["vary", "Routa sets on automatic OPTIONS responses"],
	["deprecation", "Routa's lifecycle headers emit"],
	["sunset", "Routa's lifecycle headers emit"],
	["link", "Routa's lifecycle headers emit"],
	["www-authenticate", "Routa's authentication challenges use"],
]);

/**
 * The method a framework event logs: one of the standard methods as the request spelled it, or
 * `_OTHER`, so a client cannot fill logs with arbitrary method names.
 */
const loggedMethods: ReadonlySet<string> = new Set([
	"GET",
	"HEAD",
	"POST",
	"PUT",
	"PATCH",
	"DELETE",
	"OPTIONS",
	"CONNECT",
	"TRACE",
]);

export function loggedMethod(method: string): string {
	return loggedMethods.has(method) ? method : "_OTHER";
}

/**
 * Reads the `correlation` option: the lowercase header name Routa reads and echoes, or `undefined`
 * when correlation is off.
 *
 * @throws {TypeError} When the option has the wrong shape, the header name is invalid, or it names
 *   x-request-id, a credential header, or a header Routa writes itself
 */
export function correlationHeaderOf(option: unknown): string | undefined {
	if (option === undefined || option === false) {
		return undefined;
	}

	if (option === true) {
		return defaultCorrelationHeader;
	}

	const header =
		typeof option === "object"
		&& option !== null
		&& !Array.isArray(option)
		&& Object.keys(option).every((key) => key === "header")
			? (option as { header?: unknown }).header
			: undefined;

	if (typeof header !== "string") {
		throw new TypeError(
			'correlation must be true, false, or { header: "x-correlation-id" } with the header Routa reads and echoes.',
		);
	}

	const problem = correlationHeaderProblem(header);

	if (problem) {
		throw new TypeError(`The correlation header ${problem}`);
	}

	return header.toLowerCase();
}

/**
 * Rejects a correlation header that a declared credential scheme reads, so a credential never
 * lands in correlation. Only the declared transports are read; no extractor or authenticator runs.
 *
 * @param header - The lowercase header {@link correlationHeaderOf} returned
 * @param authentication - The validated authentication config
 * @throws {TypeError} When an `apiKey` or `custom` scheme reads its credential from the header
 */
export function assertCorrelationReadsNoCredential(
	header: string | undefined,
	authentication: RuntimeAuthentication | undefined,
): void {
	const scheme =
		header === undefined
			? undefined
			: authentication?.schemes.find(
					(item) => "header" in item.transport && item.transport.header === header,
				);

	if (scheme) {
		throw new TypeError(
			`The correlation header ${JSON.stringify(header)} is the header the ${scheme.kind} scheme ${JSON.stringify(scheme.name)} reads its credential from. Choose another header, such as x-correlation-id.`,
		);
	}
}

/**
 * Why a correlation header name cannot be used, or `undefined` when it can. Names compare
 * case-insensitively.
 */
export function correlationHeaderProblem(header: string): string | undefined {
	const name = header.toLowerCase();

	if (!headerName.test(header)) {
		return `${JSON.stringify(header)} is not a valid header name. Use letters, digits, and ! # $ % & ' * + - . ^ _ \` | ~.`;
	}

	if (name === requestIdHeader) {
		return `${JSON.stringify(header)} names x-request-id, which carries the request identity Routa generates. Choose another header, such as x-correlation-id.`;
	}

	if (credentialHeaders.has(name)) {
		return `${JSON.stringify(header)} names a credential header. A correlation ID is not a credential, so choose another header, such as x-correlation-id.`;
	}

	const owner = routaHeaders.get(name);

	if (owner) {
		return `${JSON.stringify(header)} names ${name}, which ${owner}. Choose another header, such as x-correlation-id.`;
	}

	return undefined;
}

/**
 * The caller's correlation ID: the header's one value when it matches the grammar. An absent,
 * empty, repeated, or otherwise invalid value is ignored; repeated fields arrive joined by a comma,
 * which the grammar excludes.
 */
export function acceptedCorrelation(headers: Headers, header: string): string | undefined {
	const value = headers.get(header);
	return value !== null && correlationValue.test(value) ? value : undefined;
}
