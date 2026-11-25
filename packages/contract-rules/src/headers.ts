/** The response header that carries Routa's generated request identity. */
export const requestIdHeader = "x-request-id";

/** The correlation header `correlation: true` reads and echoes. */
export const defaultCorrelationHeader = "x-correlation-id";

/**
 * Header names Routa owns on every response, so no outcome can declare them. The declaration
 * types derive their reserved names from this list.
 */
export const reservedResponseHeaders = [
	"content-type",
	"content-length",
	"transfer-encoding",
	"connection",
	"set-cookie",
	requestIdHeader,
] as const;

/** RFC 9110 `token`, the grammar of header names. */
const headerName = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** Whether `name` is a valid header name, in any casing. */
export function isHeaderName(name: string): boolean {
	return headerName.test(name);
}

/** The characters a correlation ID may hold, as a regular expression character class body. */
const correlationCharacters = "A-Za-z0-9._-";
const correlationMaxLength = 128;
const correlationValue = new RegExp(`^[${correlationCharacters}]{1,${correlationMaxLength}}$`);

/** Whether `value` is one correlation ID: 1 to 128 ASCII letters, digits, `.`, `_`, or `-`. */
export function isCorrelationValue(value: string): boolean {
	return correlationValue.test(value);
}

/** The OpenAPI schema of a correlation ID, from the grammar {@link isCorrelationValue} checks. */
export const correlationValueSchema = {
	type: "string",
	minLength: 1,
	maxLength: correlationMaxLength,
	pattern: `^[${correlationCharacters}]+$`,
} as const;

/**
 * Headers a correlation header cannot name, and why: credential headers, and the headers Routa
 * writes itself, which the echo would replace. Headers that authentication schemes or outcomes
 * declare are checked with those declarations.
 */
const claimedHeaders: ReadonlyMap<string, string> = new Map([
	...reservedResponseHeaders.map(
		(name) => [name, "is a header Routa owns on every response"] as const,
	),
	[requestIdHeader, "carries the request identity Routa generates"],
	["authorization", "is a credential header"],
	["proxy-authorization", "is a credential header"],
	["cookie", "is a credential header"],
	["set-cookie", "is a credential header"],
	["allow", "is a header Routa sets on automatic OPTIONS and 405 responses"],
	["access-control-allow-methods", "is a header Routa sets on automatic OPTIONS responses"],
	["vary", "is a header Routa sets on automatic OPTIONS responses"],
	["deprecation", "is a lifecycle header Routa emits"],
	["sunset", "is a lifecycle header Routa emits"],
	["link", "is a lifecycle header Routa emits"],
	["www-authenticate", "carries Routa's authentication challenges"],
]);

/** A configured credential scheme that reads its credential from a header of its own. */
export type HeaderCredentialScheme = {
	readonly kind: string;
	readonly name: string;
	/** The header the scheme reads, in any casing. */
	readonly header: string;
};

/**
 * Why a header cannot be the correlation header. Callers write `reason` after the header they
 * name, then `advice`, as one error or as a diagnostic's message and suggestion.
 */
export type CorrelationHeaderProblem = {
	readonly kind: "invalid" | "conflict";
	/** Follows the header, such as `names cookie, which is a credential header`. */
	readonly reason: string;
	readonly advice: string;
};

/**
 * Why `header` cannot be the correlation header, or `undefined` when it can. Names compare
 * case-insensitively.
 *
 * @param schemes - The configured schemes that read a header of their own, or `undefined` when
 *   the caller has not read them yet. The advice names `x-correlation-id` only when the caller
 *   passed the schemes and none reads it.
 */
export function correlationHeaderProblem(
	header: string,
	schemes?: readonly HeaderCredentialScheme[],
): CorrelationHeaderProblem | undefined {
	const readsHeader = (name: string) =>
		schemes?.find((scheme) => scheme.header.toLowerCase() === name);
	const defaultIsFree = schemes !== undefined && !readsHeader(defaultCorrelationHeader);

	if (!isHeaderName(header)) {
		return {
			kind: "invalid",
			reason: "is not a valid header name",
			advice: `Use a header name made of letters, digits, and the characters ! # $ % & ' * + - . ^ _ \` | ~${defaultIsFree ? `, such as ${defaultCorrelationHeader}` : ""}.`,
		};
	}

	const name = header.toLowerCase();
	const scheme = readsHeader(name);
	const claim =
		claimedHeaders.get(name)
		?? (scheme
			&& `the ${scheme.kind} scheme ${JSON.stringify(scheme.name)} reads its credential from`);

	if (!claim) {
		return undefined;
	}

	return {
		kind: "conflict",
		reason: `names ${name}, which ${claim}`,
		advice: `Choose a header of its own for correlation, ${defaultIsFree ? `such as ${defaultCorrelationHeader}` : "one no configured scheme reads and no route declares"}. A correlation ID is not a credential and never replaces ${requestIdHeader}.`,
	};
}
