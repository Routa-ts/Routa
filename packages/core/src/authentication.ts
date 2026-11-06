import { z } from "zod";
import type { MiddlewareContract, Register } from "./index.js";
import type { RoutaLogger } from "./logger.js";

type MaybePromise<T> = T | Promise<T>;

/** What every principal carries: a stable `id`, and a `type` that may discriminate actors. */
export type Principal = { readonly id: string; readonly type: string };

/** The one application-wide Zod schema whose output types and validates every principal. */
export type PrincipalSchema = z.ZodType<{ id: string; type: string }, any>;

/**
 * What an authenticator returns: the principal candidate it authenticated, which Routa parses with
 * the principal schema, or an explicit rejection. A rejection carries no reason, so nothing the
 * application or its provider knows about the failure reaches the response.
 */
export type AuthenticationResult<TPrincipal = unknown> =
	| { readonly type: "authenticated"; readonly principal: TPrincipal }
	| { readonly type: "rejected" };

/**
 * What an authenticator receives besides the credential: the logger and, when `src/routa.ts`
 * configures them, the application services. Route-file and method services do not exist yet when
 * it runs.
 */
export type AuthenticatorContext = Register extends { applicationServices: infer TServices }
	? { readonly logger: RoutaLogger; readonly services: Readonly<TServices> }
	: { readonly logger: RoutaLogger };

/**
 * Application code that verifies one extracted credential. Throw for unexpected failures, which
 * stay server errors; return `{ type: "rejected" }` for a credential that is not valid.
 */
export type Authenticator<TResult extends AuthenticationResult = AuthenticationResult> = (
	credential: string,
	context: AuthenticatorContext,
) => MaybePromise<TResult>;

/** A static challenge override. `realm` must be printable ASCII without `"` or `\`. */
export type CredentialChallenge = { readonly realm?: string };

export type BearerOptions<TResult extends AuthenticationResult> = {
	/** A static challenge override, read from source. Write it as a literal. */
	readonly challenge?: CredentialChallenge;
	/** Verifies the token from `Authorization: Bearer <token>`. */
	readonly authenticate: Authenticator<TResult>;
};

/** A credential scheme whose credential is an `Authorization: Bearer <token>` header. */
export type BearerScheme<TResult extends AuthenticationResult = AuthenticationResult> = {
	readonly kind: "bearer";
	readonly challenge?: CredentialChallenge | undefined;
	readonly authenticate: Authenticator<TResult>;
};

export type ApiKeyOptions<TResult extends AuthenticationResult> = {
	/** The request header that carries the key, such as `"x-api-key"`. Write it as a literal. */
	readonly header: string;
	/** A static challenge override, read from source. Write it as a literal. */
	readonly challenge?: CredentialChallenge;
	/** Verifies the key from the header. */
	readonly authenticate: Authenticator<TResult>;
};

/** A credential scheme whose credential is the value of one request header. */
export type ApiKeyScheme<TResult extends AuthenticationResult = AuthenticationResult> = {
	readonly kind: "apiKey";
	readonly header: string;
	readonly challenge?: CredentialChallenge | undefined;
	readonly authenticate: Authenticator<TResult>;
};

export type SessionCookieOptions<TResult extends AuthenticationResult> = {
	/** The request cookie that carries the session, such as `"session"`. Write it as a literal. */
	readonly cookie: string;
	/** A static challenge override, read from source. Write it as a literal. */
	readonly challenge?: CredentialChallenge;
	/** Verifies the session value from the cookie. */
	readonly authenticate: Authenticator<TResult>;
};

/** A credential scheme whose credential is the value of one request cookie. */
export type SessionCookieScheme<TResult extends AuthenticationResult = AuthenticationResult> = {
	readonly kind: "sessionCookie";
	readonly cookie: string;
	readonly challenge?: CredentialChallenge | undefined;
	readonly authenticate: Authenticator<TResult>;
};

/** A credential scheme descriptor, such as one {@link bearer}, {@link apiKey}, or {@link sessionCookie} returns. */
export type CredentialScheme = BearerScheme<any> | ApiKeyScheme<any> | SessionCookieScheme<any>;

/**
 * The `authentication` field of `createRouta`: one principal schema and the credential schemes,
 * keyed by scheme name. Scheme names, descriptor kinds, header and cookie names, challenge
 * overrides, `priority`, and `multipleCredentials` are contract facts `routa generate` reads from
 * source, so write them as literals.
 */
export type AuthenticationConfig = {
	readonly principal: PrincipalSchema;
	readonly schemes: Readonly<Record<string, CredentialScheme>>;
	/**
	 * The order in which Routa selects among presented credentials, listing every scheme exactly
	 * once. Defaults to the order `schemes` declares them.
	 */
	readonly priority?: readonly string[];
	/**
	 * What a request presenting credentials of more than one allowed scheme gets: `"priority"`
	 * (the default) authenticates the first by priority; `"reject"` answers `ambiguousCredentials`
	 * (`400`) before any authenticator runs.
	 */
	readonly multipleCredentials?: "priority" | "reject";
};

/** `ctx.auth` for a request that presented no credential. */
export type AnonymousAuthContext = { readonly status: "anonymous" };

/** `ctx.auth` for a request whose credential the scheme's authenticator accepted. */
export type AuthenticatedAuthContext<TScheme extends string = string, TPrincipal = Principal> = {
	readonly status: "authenticated";
	readonly scheme: TScheme;
	readonly principal: TPrincipal;
};

/** `ctx.auth`: anonymous, or authenticated through one scheme with a parsed principal. */
export type AuthContext<TScheme extends string = string, TPrincipal = Principal> =
	| AnonymousAuthContext
	| AuthenticatedAuthContext<TScheme, TPrincipal>;

/** The principal schema's output type for a `createRouta` configuration. */
export type PrincipalOf<TConfig> = TConfig extends {
	readonly authentication: { readonly principal: infer TSchema extends z.ZodTypeAny };
}
	? z.output<TSchema>
	: never;

type ResultOf<TScheme> = TScheme extends { readonly authenticate: Authenticator<infer TResult> }
	? TResult
	: never;

/**
 * The fields a rejection sets besides `type`, read from each union member on its own. A field
 * TypeScript adds as `undefined` when it unifies object literals, such as `principal`, sets
 * nothing.
 */
type RejectionFields<TResult> = TResult extends { readonly type: "authenticated" }
	? never
	: {
			[K in keyof TResult]-?: K extends "type"
				? never
				: [TResult[K]] extends [undefined]
					? never
					: K;
		}[keyof TResult];

/**
 * Compile-time checks for `createRouta`: every scheme's authenticated principal must be a valid
 * input of the principal schema, a rejection carries no other fields, and `priority` names only
 * configured schemes.
 */
export type AuthenticationChecks<TConfig> = TConfig extends {
	readonly authentication: {
		readonly principal: infer TSchema extends z.ZodTypeAny;
		readonly schemes: infer TSchemes;
	};
}
	? {
			readonly authentication: {
				readonly schemes: {
					readonly [K in keyof TSchemes]: ([
						Extract<ResultOf<TSchemes[K]>, { readonly type: "authenticated" }>["principal"],
					] extends [z.input<TSchema>]
						? unknown
						: { readonly authenticate: Authenticator<AuthenticationResult<z.input<TSchema>>> })
						& ([RejectionFields<ResultOf<TSchemes[K]>>] extends [never]
							? unknown
							: {
									readonly 'A rejection is { type: "rejected" } with no other fields, so no failure detail reaches the response.': never;
								});
				};
				readonly priority?: readonly (keyof TSchemes & string)[];
			};
		}
	: unknown;

/**
 * Declares a credential scheme that reads `Authorization: Bearer <token>`. Routa extracts the
 * token, calls `authenticate` once, and parses an authenticated principal with the principal
 * schema. The application owns verifying the token.
 *
 * @throws {TypeError} When the challenge override is invalid or `authenticate` is not a function
 */
export function bearer<const TResult extends AuthenticationResult>(
	options: BearerOptions<TResult>,
): BearerScheme<TResult> {
	return descriptor("bearer", options, {}) as BearerScheme<TResult>;
}

/**
 * Declares a credential scheme that reads an API key from one request header. Routa extracts the
 * header value, calls `authenticate` once, and parses an authenticated principal with the
 * principal schema. The application owns verifying the key.
 *
 * @throws {TypeError} When the header name or challenge override is invalid, or `authenticate`
 *   is not a function
 */
export function apiKey<const TResult extends AuthenticationResult>(
	options: ApiKeyOptions<TResult>,
): ApiKeyScheme<TResult> {
	return descriptor("apiKey", options, { header: options?.header }) as ApiKeyScheme<TResult>;
}

/**
 * Declares a credential scheme that reads a session from one request cookie. Routa extracts the
 * cookie value, calls `authenticate` once, and parses an authenticated principal with the
 * principal schema. The application owns sessions and verifying their values.
 *
 * @throws {TypeError} When the cookie name or challenge override is invalid, or `authenticate`
 *   is not a function
 */
export function sessionCookie<const TResult extends AuthenticationResult>(
	options: SessionCookieOptions<TResult>,
): SessionCookieScheme<TResult> {
	return descriptor("sessionCookie", options, {
		cookie: options?.cookie,
	}) as SessionCookieScheme<TResult>;
}

type SchemeKind = CredentialScheme["kind"];

/** Each kind's constructor, and the auth-scheme its challenges name. */
const kinds: Record<SchemeKind, { readonly call: string; readonly challenge: string }> = {
	bearer: { call: "bearer()", challenge: "Bearer" },
	apiKey: { call: "apiKey()", challenge: "ApiKey" },
	sessionCookie: { call: "sessionCookie()", challenge: "Session" },
};

/** "A Bearer" or "An ApiKey", for messages. */
const article = (scheme: string) => (scheme.startsWith("A") ? `An ${scheme}` : `A ${scheme}`);

function descriptor(
	kind: SchemeKind,
	options: { readonly challenge?: unknown; readonly authenticate?: unknown } | undefined,
	transport: { readonly header?: unknown; readonly cookie?: unknown },
): CredentialScheme {
	const { call } = kinds[kind];

	if (typeof options?.authenticate !== "function") {
		throw new TypeError(`${call} needs an authenticate function.`);
	}

	const problem =
		transportProblem(kind, transport) ?? challengeProblem(options.challenge, kinds[kind].challenge);

	if (problem) {
		throw new TypeError(`${call} ${problem}`);
	}

	return Object.freeze({
		kind,
		...transport,
		...(options.challenge !== undefined && {
			challenge: Object.freeze({ ...(options.challenge as CredentialChallenge) }),
		}),
		authenticate: options.authenticate,
	}) as CredentialScheme;
}

/** RFC 9110 `token`, the grammar of header names and, in RFC 6265, of cookie names. */
const tokenNamePattern = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** Why an API-key header or session cookie name is invalid, or `undefined`. */
function transportProblem(
	kind: SchemeKind,
	transport: { readonly header?: unknown; readonly cookie?: unknown },
): string | undefined {
	if (kind === "apiKey" && !isTokenName(transport.header)) {
		return 'header must be an HTTP header name, such as "x-api-key".';
	}

	if (kind === "sessionCookie" && !isTokenName(transport.cookie)) {
		return 'cookie must be a cookie name, such as "session".';
	}

	return undefined;
}

function isTokenName(value: unknown): value is string {
	return typeof value === "string" && tokenNamePattern.test(value);
}

/** Printable ASCII without `"` or `\`, so a realm never needs escaping in a quoted string. */
const realmPattern = /^[\x20\x21\x23-\x5b\x5d-\x7e]+$/;

/** Why a challenge override is invalid, or `undefined`. `routa check` reports the same rules. */
function challengeProblem(challenge: unknown, scheme: string): string | undefined {
	if (challenge === undefined) {
		return undefined;
	}

	if (typeof challenge !== "object" || challenge === null || Array.isArray(challenge)) {
		return 'challenge must be an object such as { realm: "api" }.';
	}

	const unknown = Object.keys(challenge).find((key) => key !== "realm");

	if (unknown !== undefined) {
		return `challenge declares "${unknown}". ${article(scheme)} challenge override accepts only realm.`;
	}

	const { realm } = challenge as { realm?: unknown };

	if (realm !== undefined && (typeof realm !== "string" || !realmPattern.test(realm))) {
		return 'challenge realm must be a non-empty string of printable ASCII without " or \\.';
	}

	return undefined;
}

const challengeHeaders = z.object({ "www-authenticate": z.string() });

/** The outcome `requireAuth` returns when a protected operation receives no credential. */
export const authenticationRequiredOutcome = {
	status: 401,
	description: "Authentication is required: the request presented no credential.",
	schema: z.object({
		type: z.literal("https://routa-ts.dev/problems/authentication-required"),
		title: z.literal("Authentication required"),
		status: z.literal(401),
	}),
	headers: challengeHeaders,
} as const;

/** The outcome Routa returns for a presented credential that is malformed, unsupported, or rejected. */
export const authenticationFailedOutcome = {
	status: 401,
	description:
		"Authentication failed: the request presented a credential that is malformed, unsupported, or rejected.",
	schema: z.object({
		type: z.literal("https://routa-ts.dev/problems/authentication-failed"),
		title: z.literal("Authentication failed"),
		status: z.literal(401),
	}),
	headers: challengeHeaders,
} as const;

const authenticationRequiredBody = {
	type: "https://routa-ts.dev/problems/authentication-required",
	title: "Authentication required",
	status: 401,
} as const;

const authenticationFailedBody = {
	type: "https://routa-ts.dev/problems/authentication-failed",
	title: "Authentication failed",
	status: 401,
} as const;

/**
 * The outcome Routa returns, when `multipleCredentials` is `"reject"`, for a request presenting
 * credentials of more than one scheme the operation accepts. No challenge applies: the client
 * holds credentials and must send one.
 */
export const ambiguousCredentialsOutcome = {
	status: 400,
	description:
		"Ambiguous credentials: the request presented credentials of more than one scheme the operation accepts.",
	schema: z.object({
		type: z.literal("https://routa-ts.dev/problems/ambiguous-credentials"),
		title: z.literal("Ambiguous credentials"),
		status: z.literal(400),
	}),
} as const;

const ambiguousCredentialsBody = {
	type: "https://routa-ts.dev/problems/ambiguous-credentials",
	title: "Ambiguous credentials",
	status: 400,
} as const;

type RegisteredSchemeName = Register extends { authentication: { schemes: infer TName } }
	? TName & string
	: never;

export type RequireAuthOptions<TSchemes extends readonly string[]> = {
	/** The schemes the operation accepts, as a literal list. Omit it to accept any scheme. */
	readonly schemes: TSchemes;
};

/** The middleware contract `requireAuth` returns. */
export type RequireAuthMiddleware = MiddlewareContract<
	readonly [],
	Record<never, never>,
	{ readonly authenticationRequired: typeof authenticationRequiredOutcome },
	undefined
>;

/** The allowed schemes each `requireAuth` contract declares; `undefined` means any scheme. */
const requirements = new WeakMap<object, { readonly schemes?: readonly string[] }>();

/**
 * A middleware guard that rejects anonymous requests with `authenticationRequired` (`401`) and
 * narrows the handler's `ctx.auth` to authenticated. It requires
 * `authentication` in `createRouta`. Write it inline in a route's or method's `middleware`, so
 * `routa check` can read it.
 *
 * @param options - The schemes the operation accepts; omit to accept any configured scheme
 * @throws {TypeError} When `schemes` is not a non-empty list of names
 */
export function requireAuth<
	const TSchemes extends readonly RegisteredSchemeName[] = readonly RegisteredSchemeName[],
>(options?: RequireAuthOptions<TSchemes>): RequireAuthMiddleware {
	const schemes = options?.schemes;

	if (
		options !== undefined
		&& (!Array.isArray(schemes)
			|| schemes.length === 0
			|| schemes.some((name) => typeof name !== "string"))
	) {
		throw new TypeError("requireAuth() schemes must be a non-empty list of scheme names.");
	}

	const contract: RequireAuthMiddleware = Object.freeze({
		rejects: Object.freeze({ authenticationRequired: authenticationRequiredOutcome }),
		run: () => {
			throw new Error(
				"requireAuth() runs only in an application that configures authentication in createRouta.",
			);
		},
	});
	requirements.set(contract, schemes ? { schemes: Object.freeze([...schemes]) } : {});
	return contract;
}

/** One configured scheme, ready to extract and authenticate credentials. */
type RuntimeScheme = {
	readonly name: string;
	readonly kind: SchemeKind;
	/** The header an API-key scheme reads, lowercase. */
	readonly header?: string | undefined;
	/** The cookie a session scheme reads. */
	readonly cookie?: string | undefined;
	readonly realm?: string | undefined;
	readonly authenticate: Authenticator<any>;
};

/** A validated `authentication` configuration. */
export type RuntimeAuthentication = {
	readonly principal: PrincipalSchema;
	/** In priority order. */
	readonly schemes: readonly RuntimeScheme[];
	readonly multipleCredentials: "priority" | "reject";
};

/** Scheme names are OpenAPI security scheme keys, so they follow the component key rule. */
// A leading letter also keeps names out of JavaScript's integer-key ordering, so scheme order is
// the same in source, at runtime, and in generated metadata.
const schemeNamePattern = /^[a-zA-Z][a-zA-Z0-9.\-_]*$/;

/**
 * Validates an `authentication` configuration before the application serves traffic.
 * TypeScript and `routa check` report the same rules earlier; this keeps hand-built configs honest.
 *
 * @throws {TypeError} When the principal schema, a scheme name, a descriptor, `priority`, or
 *   `multipleCredentials` is invalid, or two schemes read the same credential
 */
export function runtimeAuthentication(config: unknown): RuntimeAuthentication {
	const fail = (problem: string): never => {
		throw new TypeError(`createRouta authentication ${problem}`);
	};

	if (typeof config !== "object" || config === null || Array.isArray(config)) {
		return fail("must be an object with principal and schemes.");
	}

	const { principal, schemes, priority, multipleCredentials } = config as {
		principal?: unknown;
		schemes?: unknown;
		priority?: unknown;
		multipleCredentials?: unknown;
	};

	if (
		typeof (principal as { safeParseAsync?: unknown } | undefined)?.safeParseAsync !== "function"
	) {
		fail("principal must be a Zod schema.");
	}

	if (typeof schemes !== "object" || schemes === null || Array.isArray(schemes)) {
		return fail("schemes must be an object keyed by scheme name.");
	}

	const declared: RuntimeScheme[] = [];

	for (const [name, value] of Object.entries(schemes)) {
		const scheme = value as {
			kind?: unknown;
			header?: string;
			cookie?: string;
			challenge?: CredentialChallenge;
			authenticate?: unknown;
		} | null;
		const kind = scheme?.kind as SchemeKind;

		if (!schemeNamePattern.test(name)) {
			fail(
				`scheme name "${name}" must start with a letter and use only letters, digits, ".", "-", and "_".`,
			);
		}

		if (!Object.hasOwn(kinds, kind ?? "") || typeof scheme?.authenticate !== "function") {
			fail(`scheme "${name}" must be declared with bearer(), apiKey(), or sessionCookie().`);
		}

		const problem =
			transportProblem(kind, scheme!) ?? challengeProblem(scheme?.challenge, kinds[kind].challenge);

		if (problem) {
			fail(`scheme "${name}" ${problem}`);
		}

		const runtime: RuntimeScheme = {
			name,
			kind,
			...(kind === "apiKey" && { header: scheme!.header!.toLowerCase() }),
			...(kind === "sessionCookie" && { cookie: scheme!.cookie }),
			realm: scheme?.challenge?.realm,
			authenticate: scheme!.authenticate as Authenticator<any>,
		};
		const overlap = transportOverlap(runtime, declared);

		if (overlap) {
			fail(overlap);
		}

		declared.push(runtime);
	}

	if (declared.length === 0) {
		fail("declares no credential schemes.");
	}

	if (
		multipleCredentials !== undefined
		&& multipleCredentials !== "priority"
		&& multipleCredentials !== "reject"
	) {
		fail('multipleCredentials must be "priority" or "reject".');
	}

	return Object.freeze({
		principal: principal as PrincipalSchema,
		schemes: Object.freeze(prioritized(declared, priority, fail)),
		multipleCredentials: (multipleCredentials ?? "priority") as "priority" | "reject",
	});
}

/** Why a scheme reads bytes another built-in scheme already reads, or `undefined`. */
function transportOverlap(
	scheme: RuntimeScheme,
	earlier: readonly RuntimeScheme[],
): string | undefined {
	if (scheme.header === "authorization") {
		return `scheme "${scheme.name}" reads the Authorization header, which carries Authorization-scheme credentials such as Bearer. Use bearer() for Bearer tokens.`;
	}

	if (scheme.header === "cookie") {
		return `scheme "${scheme.name}" reads the Cookie header, which carries cookies. Use sessionCookie() for a session cookie.`;
	}

	const other = earlier.find(
		(item) =>
			item.kind === scheme.kind && item.header === scheme.header && item.cookie === scheme.cookie,
	);

	if (!other) {
		return undefined;
	}

	const both = `schemes "${other.name}" and "${scheme.name}" both read`;
	return scheme.kind === "bearer"
		? `${both} the Authorization Bearer credential. Verify every token format in one authenticator.`
		: scheme.kind === "apiKey"
			? `${both} the ${scheme.header} header. Verify every key format in one authenticator.`
			: `${both} the "${scheme.cookie}" cookie. Verify every session format in one authenticator.`;
}

/** Orders schemes by `priority`, which must list each exactly once; without it, as declared. */
function prioritized(
	declared: readonly RuntimeScheme[],
	priority: unknown,
	fail: (problem: string) => never,
): RuntimeScheme[] {
	if (priority === undefined) {
		return [...declared];
	}

	if (!Array.isArray(priority) || priority.some((name) => typeof name !== "string")) {
		return fail("priority must be a list of scheme names.");
	}

	const ordered: RuntimeScheme[] = [];

	for (const name of priority as string[]) {
		const scheme = declared.find((item) => item.name === name);

		if (!scheme) {
			fail(`priority lists "${name}", which schemes does not declare.`);
		}

		if (ordered.includes(scheme!)) {
			fail(`priority lists "${name}" more than once.`);
		}

		ordered.push(scheme!);
	}

	const missing = declared.find((scheme) => !ordered.includes(scheme));

	if (missing) {
		fail(`priority omits "${missing.name}". List every scheme exactly once.`);
	}

	return ordered;
}

/**
 * One route's authentication: the application's configuration, and the schemes the route
 * accepts, in priority order.
 */
export type RouteAuthentication = {
	readonly authentication: RuntimeAuthentication;
	readonly allowed: readonly RuntimeScheme[];
};

/**
 * Prepares one route's authentication at registration. The schemes it accepts are those every
 * `requireAuth` guard in its middleware chain allows, or every configured scheme without a
 * guard. Credential selection considers only these, so a credential of another scheme never
 * authenticates the request. Each `requireAuth` contract becomes the guard that enforces them.
 *
 * @param label - Names the route in messages, such as `GET /orders`
 * @param bodyless - Whether the route is an explicit HEAD operation, whose outcomes have no body
 * @throws {Error} When a guard appears without authentication, names an unknown scheme, or the
 *   guards allow no scheme in common
 */
export function routeAuthentication<TItem extends object>(
	middleware: readonly TItem[],
	authentication: RuntimeAuthentication | undefined,
	label: string,
	bodyless = false,
): { readonly middleware: readonly TItem[]; readonly authentication?: RouteAuthentication } {
	const guarded = middleware.filter((item) => requirements.has(item));

	if (!authentication) {
		if (guarded.length > 0) {
			throw new Error(
				`requireAuth() on ${label} needs authentication. Configure authentication in createRouta.`,
			);
		}

		return { middleware };
	}

	let allowed = authentication.schemes;

	for (const item of guarded) {
		const names = requirements.get(item)!.schemes;
		const unknown = names?.find(
			(name) => !authentication.schemes.some((scheme) => scheme.name === name),
		);

		if (unknown !== undefined) {
			throw new Error(
				`requireAuth() on ${label} allows scheme "${unknown}", which createRouta authentication does not declare.`,
			);
		}

		allowed = names ? allowed.filter((scheme) => names.includes(scheme.name)) : allowed;
	}

	if (allowed.length === 0) {
		throw new Error(`requireAuth() guards on ${label} allow no scheme in common.`);
	}

	const route: RouteAuthentication = Object.freeze({ authentication, allowed });

	return {
		middleware:
			guarded.length === 0
				? middleware
				: middleware.map((item) =>
						requirements.has(item) ? (authenticationGuard(item, allowed, bodyless) as TItem) : item,
					),
		authentication: route,
	};
}

/**
 * Whether an operation can answer `ambiguousCredentials`: strict multiple-credential mode, and
 * more than one scheme the operation accepts.
 */
export function rejectsAmbiguousCredentials(route: RouteAuthentication): boolean {
	return route.authentication.multipleCredentials === "reject" && route.allowed.length > 1;
}

/**
 * The guard that enforces one `requireAuth` contract: it rejects a request not authenticated
 * through an allowed scheme, challenging every allowed scheme.
 */
function authenticationGuard(
	item: object,
	allowed: readonly RuntimeScheme[],
	bodyless: boolean,
): object {
	const challenge = challengeAll(allowed);
	const names = new Set(allowed.map((scheme) => scheme.name));
	const guard = Object.freeze({
		rejects: Object.freeze({
			authenticationRequired: bodyless
				? bodylessOutcome(authenticationRequiredOutcome)
				: authenticationRequiredOutcome,
		}),
		run: ({ ctx, next }: { ctx: Record<string, unknown>; next: () => Promise<object> }) => {
			const auth = ctx.auth as AuthContext | undefined;
			return auth?.status === "authenticated" && names.has(auth.scheme)
				? next()
				: {
						type: "authenticationRequired",
						...(bodyless ? {} : { data: authenticationRequiredBody }),
						headers: { "www-authenticate": challenge },
					};
		},
	});
	requirements.set(guard, requirements.get(item)!);
	return guard;
}

/** Whether a middleware contract is a `requireAuth` guard. */
export function isAuthenticationGuard(item: object): boolean {
	return requirements.has(item);
}

/**
 * A credential a request presents for one scheme, before any authenticator runs. Without a
 * `credential`, it is malformed.
 */
type Presented = { readonly scheme: RuntimeScheme; readonly credential?: string };

// RFC 9110 separates an auth-scheme from its credential with spaces only.
const authSchemePattern = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+)(?: +(.*))?$/s;
/** RFC 6750 `b64token`. */
const tokenPattern = /^[A-Za-z0-9\-._~+/]+=*$/;

/**
 * Reads each scheme's credential from the request, in priority order, and whether the request
 * carries an `Authorization` credential no configured scheme reads.
 *
 * A Bearer token that is empty or not an RFC 6750 `b64token` is malformed. An API-key header
 * that is empty or holds a comma is malformed: `Headers` joins a repeated header with `", "`, so
 * a comma means the key cannot be told apart from two keys. A session cookie that is empty or
 * repeated is malformed.
 */
function presentedCredentials(
	schemes: readonly RuntimeScheme[],
	request: Request,
): { readonly credentials: readonly Presented[]; readonly unsupported: boolean } {
	const authorization = request.headers.get("authorization");
	const match = authorization === null ? null : authSchemePattern.exec(authorization.trim());
	const isBearer = match?.[1]?.toLowerCase() === "bearer";
	const credentials: Presented[] = [];
	let cookies: Map<string, string[]> | undefined;

	for (const scheme of schemes) {
		if (scheme.kind === "bearer") {
			if (isBearer) {
				const token = match?.[2]?.trim() ?? "";
				credentials.push(tokenPattern.test(token) ? { scheme, credential: token } : { scheme });
			}
		} else if (scheme.kind === "apiKey") {
			const value = request.headers.get(scheme.header!);

			if (value !== null) {
				credentials.push(
					value === "" || value.includes(",") ? { scheme } : { scheme, credential: value },
				);
			}
		} else {
			cookies ??= requestCookies(request);
			const values = cookies.get(scheme.cookie!);

			if (values) {
				credentials.push(
					values.length === 1 && values[0] !== "" ? { scheme, credential: values[0]! } : { scheme },
				);
			}
		}
	}

	return {
		credentials,
		unsupported:
			authorization !== null && !(isBearer && schemes.some((scheme) => scheme.kind === "bearer")),
	};
}

/** Every value each cookie name carries, decoded as `input.cookies` decodes them. */
function requestCookies(request: Request): Map<string, string[]> {
	const cookies = new Map<string, string[]>();

	for (const item of (request.headers.get("cookie") ?? "").split(";")) {
		const index = item.indexOf("=");
		const name = index === -1 ? "" : item.slice(0, index).trim();

		if (name) {
			const raw = item.slice(index + 1).trim();
			let value = raw;

			try {
				value = decodeURIComponent(raw);
			} catch {
				// Malformed percent-encoding stays raw, as in input.cookies.
			}

			cookies.set(name, [...(cookies.get(name) ?? []), value]);
		}
	}

	return cookies;
}

/** One scheme's challenge. Only Bearer adds error details, for an invalid selected token. */
function schemeChallenge(scheme: RuntimeScheme, invalid = false): string {
	const parameters = [
		...(scheme.realm === undefined ? [] : [`realm="${scheme.realm}"`]),
		...(invalid && scheme.kind === "bearer" ? ['error="invalid_token"'] : []),
	];
	const name = kinds[scheme.kind].challenge;
	return parameters.length > 0 ? `${name} ${parameters.join(", ")}` : name;
}

/** Challenges every scheme without error details, as for a missing or disallowed credential. */
function challengeAll(schemes: readonly RuntimeScheme[]): string {
	return schemes.map((scheme) => schemeChallenge(scheme)).join(", ");
}

/** The result of credential orchestration for one request. */
export type ResolvedAuthentication =
	| { readonly auth: AuthContext }
	| { readonly failed: { readonly challenge: string } }
	| { readonly ambiguous: true };

const anonymous: AnonymousAuthContext = Object.freeze({ status: "anonymous" });

/**
 * Resolves one request's credential for a route. Only credentials of schemes the route accepts
 * are eligible; the first by priority is selected, and its authenticator alone runs exactly once.
 * An accepted principal is parsed with the principal schema. Without any credential the request
 * is anonymous. A selected credential that is malformed or rejected fails without falling back,
 * and credentials of no accepted scheme fail. In strict mode, more than one eligible credential
 * is ambiguous.
 *
 * @throws {AuthenticatorError} When the authenticator throws
 * @throws {AuthenticationContractError} When it returns an invalid result or principal
 */
export async function resolveAuthentication(
	route: RouteAuthentication,
	request: Request,
	context: { readonly logger: RoutaLogger; readonly services?: unknown },
): Promise<ResolvedAuthentication> {
	const { authentication, allowed } = route;
	const { credentials, unsupported } = presentedCredentials(authentication.schemes, request);
	const eligible = credentials.filter((item) => allowed.includes(item.scheme));
	const [selected] = eligible;

	if (!selected) {
		return credentials.length > 0 || unsupported
			? { failed: { challenge: challengeAll(allowed) } }
			: { auth: anonymous };
	}

	if (eligible.length > 1 && authentication.multipleCredentials === "reject") {
		return { ambiguous: true };
	}

	if (selected.credential === undefined) {
		return { failed: { challenge: schemeChallenge(selected.scheme, true) } };
	}

	return await authenticate(authentication, selected.scheme, selected.credential, context);
}

async function authenticate(
	authentication: RuntimeAuthentication,
	scheme: RuntimeScheme,
	credential: string,
	context: { readonly logger: RoutaLogger; readonly services?: unknown },
): Promise<ResolvedAuthentication> {
	let result: unknown;

	try {
		result = await scheme.authenticate(
			credential,
			Object.freeze({
				logger: context.logger,
				...(context.services === undefined ? {} : { services: context.services }),
			}) as AuthenticatorContext,
		);
	} catch {
		throw new AuthenticatorError(scheme.name);
	}

	let type: unknown;

	try {
		type =
			typeof result === "object" && result !== null
				? (result as { type?: unknown }).type
				: undefined;
	} catch {
		// A getter threw. Its error may carry the credential, or a ZodError the generic error mapping
		// would answer with 400 and its messages.
		throw new AuthenticationContractError(
			`Reading the result type from scheme "${scheme.name}" threw.`,
		);
	}

	if (type === "rejected") {
		return { failed: { challenge: schemeChallenge(scheme, true) } };
	}

	if (type !== "authenticated") {
		throw new AuthenticationContractError(
			`Authenticator for scheme "${scheme.name}" returned a result that is neither { type: "authenticated", principal } nor { type: "rejected" }.`,
		);
	}

	let parsed: Awaited<ReturnType<PrincipalSchema["safeParseAsync"]>>;

	try {
		parsed = await authentication.principal.safeParseAsync(
			(result as { principal?: unknown }).principal,
		);
	} catch {
		// A refinement or transform threw, possibly a ZodError with application messages. It must
		// not reach the generic error mapping, which would answer 400 with those messages.
		throw new AuthenticationContractError(
			`Parsing the principal from scheme "${scheme.name}" threw.`,
		);
	}

	if (!parsed.success) {
		throw new AuthenticationContractError(
			`Authenticator for scheme "${scheme.name}" returned a principal that does not match the principal schema.`,
			parsed.error.issues.map((issue) => ({ code: issue.code, path: issue.path })),
		);
	}

	// A schema typed through `any`, such as z.any(), can output a value without the base fields.
	let principal: boolean;

	try {
		principal = isPrincipal(parsed.data);
	} catch {
		// A getter on the parsed value threw; its error may carry application or provider detail.
		throw new AuthenticationContractError(
			`Reading the principal parsed from scheme "${scheme.name}" threw.`,
		);
	}

	if (!principal) {
		throw new AuthenticationContractError(
			`The principal schema parsed the principal from scheme "${scheme.name}" to a value without string id and type fields.`,
		);
	}

	return {
		auth: Object.freeze({ status: "authenticated", scheme: scheme.name, principal: parsed.data }),
	};
}

/** Whether a value carries the string `id` and `type` every principal has. */
function isPrincipal(value: unknown): boolean {
	const { id, type } = (typeof value === "object" && value !== null ? value : {}) as {
		id?: unknown;
		type?: unknown;
	};
	return typeof id === "string" && typeof type === "string";
}

/**
 * An authentication outcome as an explicit HEAD operation declares it: the same status,
 * description, and challenge header, without a body schema, because HEAD responses have no body.
 */
export function bodylessOutcome<TOutcome extends { readonly schema?: unknown }>(
	outcome: TOutcome,
): Omit<TOutcome, "schema"> {
	const { schema: _schema, ...rest } = outcome;
	return rest;
}

/**
 * The result and outcome Routa selects for a request whose credentials failed orchestration,
 * without a body on an explicit HEAD operation.
 */
export function authenticationFailure(
	resolved: Exclude<ResolvedAuthentication, { readonly auth: AuthContext }>,
	bodyless = false,
): {
	readonly result: { type: string; data?: unknown; headers?: Record<string, string> };
	readonly outcome: { readonly status: number; readonly description: string };
} {
	if ("ambiguous" in resolved) {
		return {
			result: {
				type: "ambiguousCredentials",
				...(bodyless ? {} : { data: ambiguousCredentialsBody }),
			},
			outcome: bodyless
				? bodylessOutcome(ambiguousCredentialsOutcome)
				: ambiguousCredentialsOutcome,
		};
	}

	return {
		result: {
			type: "authenticationFailed",
			...(bodyless ? {} : { data: authenticationFailedBody }),
			headers: { "www-authenticate": resolved.failed.challenge },
		},
		outcome: bodyless ? bodylessOutcome(authenticationFailedOutcome) : authenticationFailedOutcome,
	};
}

/**
 * An authenticator threw. Routa answers with the generic `500` problem and logs only the scheme,
 * because anything the thrown value carries, including its message, stack, and name, is set by
 * application or provider code and may carry the credential.
 */
export class AuthenticatorError extends Error {
	override readonly name = "AuthenticatorError";

	constructor(readonly scheme: string) {
		super(`Authenticator for scheme "${scheme}" threw.`);
	}
}

/**
 * An authenticator returned a result or principal that breaks the authentication contract: an
 * application contract violation, answered with the generic `500` problem. Issues carry Zod codes
 * and paths only, never values.
 */
export class AuthenticationContractError extends Error {
	override readonly name = "AuthenticationContractError";

	constructor(
		message: string,
		readonly issues?: ReadonlyArray<{ code: string; path: readonly PropertyKey[] }>,
	) {
		super(message);
	}
}
