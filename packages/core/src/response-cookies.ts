import { InvalidHandlerOutputError } from "./handler-output-error.js";
import type { AnyCookie, CookieConfig, CookieEffect } from "./index.js";
import { isScalarSchema } from "./response-headers.js";

const handles = new WeakSet<object>();

const cookieNamePattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
// A path starts with "/" and uses printable ASCII except ";", with no trailing space: user agents
// trim attribute values, so a trailing space would change the scope Routa promises.
const cookiePathPattern = /^\/(?:[\x20-\x3a\x3c-\x7e]*[\x21-\x3a\x3c-\x7e])?$/;
const cookieDomainPattern =
	/^\.?[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/;
const isoDateTimePattern =
	/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;
const sameSiteValues = ["strict", "lax", "none"] as const;
const epoch = "Thu, 01 Jan 1970 00:00:00 GMT";

/** Whether a string is an ISO 8601 date-time naming a real calendar moment. */
function isIsoDateTime(value: string): boolean {
	const match = isoDateTimePattern.exec(value);

	if (!match) {
		return false;
	}

	const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [
		number,
		number,
		number,
		number,
		number,
		number,
	];
	const date = new Date(0);
	date.setUTCFullYear(year, month - 1, day);
	const offsetHour = match[7] === undefined ? 0 : Number(match[7]);
	const offsetMinute = match[8] === undefined ? 0 : Number(match[8]);

	return (
		date.getUTCFullYear() === year
		&& date.getUTCMonth() === month - 1
		&& date.getUTCDate() === day
		&& hour < 24
		&& minute < 60
		&& second < 60
		&& offsetHour < 24
		&& offsetMinute < 60
	);
}

/** One `Set-Cookie` field a response plan will send, with the identity that decides who owns it. */
export type CookieEntry = {
	/** Who produced the cookie, for conflict messages: the selected outcome today, later others. */
	producer: string;
	name: string;
	domain?: string;
	path: string;
	/** The complete `Set-Cookie` field value. */
	field: string;
};

/**
 * Describes why a cookie configuration is invalid, or returns `undefined` when it is valid.
 *
 * TypeScript and `routa check` report the same rules earlier. `createCookie` throws this message so
 * hand-built configurations stay honest.
 */
export function cookieConfigProblem(config: Partial<CookieConfig>): string | undefined {
	const { name, domain, path, maxAge, expires } = config;

	if (typeof name !== "string" || !cookieNamePattern.test(name)) {
		return "needs a name made of letters, digits, and the characters ! # $ % & ' * + - . ^ _ ` | ~.";
	}

	if (
		!config.schema
		|| !(config.schema as { _zod?: unknown })._zod
		|| !isScalarSchema(config.schema)
	) {
		return "needs a schema for a string, number, or boolean value (or a literal or enum of them).";
	}

	if (typeof config.httpOnly !== "boolean" || typeof config.secure !== "boolean") {
		return "must declare httpOnly and secure as true or false.";
	}

	if (!sameSiteValues.includes(config.sameSite as never)) {
		return 'must declare sameSite as "strict", "lax", or "none".';
	}

	if (typeof path !== "string" || !cookiePathPattern.test(path)) {
		return 'must declare a path that starts with "/", ends without a space, and uses only printable ASCII without ";". Write non-ASCII characters percent-encoded.';
	}

	if (domain !== undefined && (typeof domain !== "string" || !cookieDomainPattern.test(domain))) {
		return "declares a domain that is not a valid host name.";
	}

	if (maxAge !== undefined && (!Number.isSafeInteger(maxAge) || maxAge < 0)) {
		return "declares a maxAge that is not a non-negative whole number of seconds.";
	}

	if (expires !== undefined && (typeof expires !== "string" || !isIsoDateTime(expires))) {
		return 'declares an expires that is not an ISO 8601 date-time string such as "2030-01-01T00:00:00Z".';
	}

	if (config.partitioned !== undefined && typeof config.partitioned !== "boolean") {
		return "declares partitioned as something other than true or false.";
	}

	if (config.sameSite === "none" && !config.secure) {
		return 'sets sameSite to "none", which requires secure: true.';
	}

	if (config.partitioned && !config.secure) {
		return "is partitioned, which requires secure: true.";
	}

	const prefix = name.toLowerCase();

	if (prefix.startsWith("__secure-") && !config.secure) {
		return "uses the __Secure- prefix, which requires secure: true.";
	}

	if (prefix.startsWith("__host-")) {
		if (!config.secure) {
			return "uses the __Host- prefix, which requires secure: true.";
		}

		if (path !== "/") {
			return 'uses the __Host- prefix, which requires path: "/".';
		}

		if (domain !== undefined) {
			return "uses the __Host- prefix, which forbids a domain.";
		}
	}

	return undefined;
}

/**
 * Creates the cookie handle behind `createCookie`. Its `set` and `clear` are pure: they return
 * effects and never touch a response.
 *
 * @throws {Error} When the configuration breaks a cookie rule
 */
export function defineCookie<const TConfig extends CookieConfig>(config: TConfig): AnyCookie {
	const problem = cookieConfigProblem(config);

	if (problem) {
		throw new Error(
			`Cookie ${typeof config.name === "string" ? `"${config.name}" ` : ""}${problem}`,
		);
	}

	const handle: AnyCookie = Object.freeze({
		...config,
		set: (value: unknown) => Object.freeze({ kind: "set" as const, cookie: handle, value }),
		clear: () => Object.freeze({ kind: "clear" as const, cookie: handle }),
	});

	handles.add(handle);
	return handle;
}

export function isCookieHandle(value: unknown): value is AnyCookie {
	return typeof value === "object" && value !== null && handles.has(value);
}

/** The cookie identity: name, domain, and path. Domain compares without case or a leading dot. */
export function cookieIdentity(cookie: Pick<CookieConfig, "name" | "domain" | "path">): string {
	const domain = (cookie.domain ?? "").toLowerCase().replace(/^\./, "");
	return `${cookie.name}\0${domain}\0${cookie.path}`;
}

function describeIdentity(cookie: Pick<CookieConfig, "name" | "domain" | "path">): string {
	return `"${cookie.name}" (${cookie.domain ? `Domain=${cookie.domain}; ` : ""}Path=${cookie.path})`;
}

/** One entry of an outcome's `cookies` declaration, read as a handle and its requiredness. */
type DeclaredCookie = { cookie: AnyCookie; required: boolean };

/**
 * Reads a declaration entry: a bare handle (optional) or `{ handle, required: true }`. Returns
 * `undefined` for a wrapper of any other shape, and `null` when the handle was not made by
 * `createCookie`.
 */
function readDeclaredCookie(entry: unknown): DeclaredCookie | null | undefined {
	if (isCookieHandle(entry)) {
		return { cookie: entry, required: false };
	}

	if (typeof entry !== "object" || entry === null || !Object.hasOwn(entry, "handle")) {
		return null;
	}

	const { handle, required, ...rest } = entry as Record<string, unknown>;

	if (required !== true || Object.keys(rest).length > 0) {
		return undefined;
	}

	return isCookieHandle(handle) ? { cookie: handle, required: true } : null;
}

/** The handles an already-validated declaration lists, with their requiredness. */
function declaredCookies(cookies: unknown): DeclaredCookie[] {
	return Array.isArray(cookies)
		? cookies.flatMap((entry) => {
				const declared = readDeclaredCookie(entry);
				return declared ? [declared] : [];
			})
		: [];
}

/**
 * Describes why an outcome's `cookies` declaration is invalid, or returns `undefined`.
 *
 * Every entry must be a handle from `createCookie`, bare or as `{ handle, required: true }`, and no
 * two may share an identity.
 */
export function cookieDeclarationProblem(cookies: unknown): string | undefined {
	if (!Array.isArray(cookies)) {
		return "declares cookies that are not an array of createCookie() handles.";
	}

	const seen = new Set<string>();

	for (const entry of cookies) {
		const declared = readDeclaredCookie(entry);

		if (declared === undefined) {
			return "declares a cookie entry that is neither a createCookie() handle nor { handle, required: true }.";
		}

		if (declared === null) {
			return "declares a cookie that was not created with createCookie().";
		}

		const identity = cookieIdentity(declared.cookie);

		if (seen.has(identity)) {
			return `declares cookie ${describeIdentity(declared.cookie)} more than once. A cookie identity has one owner.`;
		}

		seen.add(identity);
	}

	return undefined;
}

/**
 * Lists declared cookies that share a name but differ in scope. They are legal, and browsers keep
 * them apart, but a reader or client is easy to confuse.
 */
export function cookieScopeWarnings(cookies: unknown): string[] {
	const byName = new Map<string, string[]>();

	for (const { cookie } of declaredCookies(cookies)) {
		byName.set(cookie.name, [...(byName.get(cookie.name) ?? []), describeIdentity(cookie)]);
	}

	return [...byName]
		.filter(([, scopes]) => scopes.length > 1)
		.map(
			([name, scopes]) =>
				`Cookies named "${name}" have different scopes: ${scopes.join(", ")}. They are separate cookies.`,
		);
}

/** An effect a result wrote, after the checks that run in every mode. */
export type ResolvedCookieEffect = CookieEffect<AnyCookie>;

/**
 * Resolves the cookie effects a handler result writes for one outcome.
 *
 * Runs in every response validation mode: only declared handles, each at most once, an effect for
 * every required handle, no raw strings. Values are not read here.
 *
 * @throws {InvalidHandlerOutputError} When the result breaks the outcome's cookie declaration
 */
export function resolveCookieEffects(
	type: string,
	outcome: { cookies?: unknown },
	written: unknown,
): ResolvedCookieEffect[] {
	const declared = Array.isArray(outcome.cookies) ? declaredCookies(outcome.cookies) : undefined;

	if (written === undefined && !declared?.some((item) => item.required)) {
		return [];
	}

	if (!declared) {
		throw new InvalidHandlerOutputError(
			`Response type "${type}" declares no cookies and cannot return cookies.`,
		);
	}

	if (written !== undefined && !Array.isArray(written)) {
		throw new InvalidHandlerOutputError(
			`Response type "${type}" returned cookies that are not an array of cookie effects.`,
		);
	}

	const seen = new Set<string>();
	const effects: ResolvedCookieEffect[] = [];

	for (const effect of (written ?? []) as unknown[]) {
		const candidate = effect as Partial<ResolvedCookieEffect> | null;

		if (
			typeof candidate !== "object"
			|| candidate === null
			|| (candidate.kind !== "set" && candidate.kind !== "clear")
			|| !isCookieHandle(candidate.cookie)
		) {
			throw new InvalidHandlerOutputError(
				`Response type "${type}" returned a cookie that is not an effect from createCookie().set() or .clear().`,
			);
		}

		const cookie = candidate.cookie;

		if (!declared.some((item) => item.cookie === cookie)) {
			throw new InvalidHandlerOutputError(
				`Response type "${type}" emits an effect for cookie ${describeIdentity(cookie)}, which it does not declare.`,
			);
		}

		const identity = cookieIdentity(cookie);

		if (seen.has(identity)) {
			throw new InvalidHandlerOutputError(
				`Response type "${type}" emits cookie ${describeIdentity(cookie)} more than once. A cookie identity has one owner.`,
			);
		}

		seen.add(identity);
		effects.push(candidate as ResolvedCookieEffect);
	}

	for (const { cookie, required } of declared) {
		if (required && !seen.has(cookieIdentity(cookie))) {
			throw new InvalidHandlerOutputError(
				`Response type "${type}" requires cookie ${describeIdentity(cookie)}, but returned no effect for it. Set or clear it.`,
			);
		}
	}

	return effects;
}

/**
 * Serializes one effect to a `Set-Cookie` field.
 *
 * Runs in every mode, so no value reaches the wire unencoded. The value is percent-encoded with
 * `encodeURIComponent`, which leaves only RFC 6265 cookie octets. Attributes follow a fixed order:
 * Domain, Path, Expires, Max-Age, HttpOnly, Secure, SameSite, Partitioned. `clear` keeps the
 * identity and security attributes, drops the original lifetime, and adds an epoch `Expires` and
 * `Max-Age=0`.
 */
export function serializeCookieEffect(
	type: string,
	effect: ResolvedCookieEffect,
	producer: string,
): CookieEntry {
	const cookie = effect.cookie;
	const encoded = effect.kind === "set" ? encodeValue(type, cookie, effect.value) : "";
	const lifetime =
		effect.kind === "clear"
			? [`Expires=${epoch}`, "Max-Age=0"]
			: [
					...(cookie.expires ? [`Expires=${new Date(cookie.expires).toUTCString()}`] : []),
					...(cookie.maxAge === undefined ? [] : [`Max-Age=${cookie.maxAge}`]),
				];
	const field = [
		`${cookie.name}=${encoded}`,
		...(cookie.domain ? [`Domain=${cookie.domain}`] : []),
		`Path=${cookie.path}`,
		...lifetime,
		...(cookie.httpOnly ? ["HttpOnly"] : []),
		...(cookie.secure ? ["Secure"] : []),
		`SameSite=${cookie.sameSite[0]!.toUpperCase()}${cookie.sameSite.slice(1)}`,
		...(cookie.partitioned ? ["Partitioned"] : []),
	].join("; ");

	return {
		producer,
		name: cookie.name,
		...(cookie.domain ? { domain: cookie.domain } : {}),
		path: cookie.path,
		field,
	};
}

function encodeValue(type: string, cookie: AnyCookie, value: unknown): string {
	if (typeof value === "string") {
		try {
			return encodeURIComponent(value);
		} catch {
			throw new InvalidHandlerOutputError(
				`Response type "${type}" wrote cookie "${cookie.name}" with a value that is not well-formed text.`,
			);
		}
	}

	if ((typeof value === "number" && Number.isFinite(value)) || typeof value === "boolean") {
		return String(value);
	}

	throw new InvalidHandlerOutputError(
		`Response type "${type}" wrote cookie "${cookie.name}" with a value that is not a string, number, or boolean.`,
	);
}

/**
 * Turns every producer's cookies into the `Set-Cookie` fields of one response.
 *
 * This is the only place a response gets cookies: route outcomes and terminal middleware rejects
 * enter through it today, and framework and authentication producers will too. Exactly one
 * producer may own an identity, so a second claim fails instead of choosing one.
 *
 * @throws {InvalidHandlerOutputError} When two entries share an identity
 */
export function planCookies(entries: readonly CookieEntry[]): string[] {
	const owners = new Map<string, CookieEntry>();

	for (const entry of entries) {
		const identity = cookieIdentity(entry);
		const earlier = owners.get(identity);

		if (earlier) {
			throw new InvalidHandlerOutputError(
				`Cookie ${describeIdentity(entry)} is produced by "${earlier.producer}" and "${entry.producer}", so Routa will not choose one.`,
			);
		}

		owners.set(identity, entry);
	}

	return entries.map((entry) => entry.field);
}
