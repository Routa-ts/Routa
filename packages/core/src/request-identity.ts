import {
	correlationHeaderProblem,
	defaultCorrelationHeader,
	type HeaderCredentialScheme,
	isCorrelationValue,
} from "@routa-ts/contract-rules";
import type { RuntimeAuthentication } from "./authentication.js";
import type { RoutaLogger } from "./logger.js";
import type { FrameworkEvent } from "./logger-registry.js";

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

	assertCorrelationHeader(header);
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
	if (header !== undefined) {
		assertCorrelationHeader(
			header,
			(authentication?.schemes ?? []).flatMap(({ kind, name, transport }) =>
				"header" in transport ? [{ kind, name, header: transport.header }] : [],
			),
		);
	}
}

/**
 * @param schemes - The schemes that read a header of their own, once the authentication config is
 *   read
 * @throws {TypeError} When the header cannot be the correlation header
 */
function assertCorrelationHeader(
	header: string,
	schemes?: readonly HeaderCredentialScheme[],
): void {
	const problem = correlationHeaderProblem(header, schemes);

	if (problem) {
		throw new TypeError(
			`The correlation header ${JSON.stringify(header)} ${problem.reason}. ${problem.advice}`,
		);
	}
}

/**
 * The caller's correlation ID: the header's one value when it matches the grammar. An absent,
 * empty, repeated, or otherwise invalid value is ignored; repeated fields arrive joined by a comma,
 * which the grammar excludes.
 */
export function acceptedCorrelation(headers: Headers, header: string): string | undefined {
	const value = headers.get(header);
	return value !== null && isCorrelationValue(value) ? value : undefined;
}
