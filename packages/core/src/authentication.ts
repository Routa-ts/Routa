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

/** A static override for a Bearer challenge. `realm` must be printable ASCII without `"` or `\`. */
export type BearerChallenge = { readonly realm?: string };

export type BearerOptions<TResult extends AuthenticationResult> = {
	/** A static challenge override, read from source. Write it as a literal. */
	readonly challenge?: BearerChallenge;
	/** Verifies the token from `Authorization: Bearer <token>`. */
	readonly authenticate: Authenticator<TResult>;
};

/** A credential scheme whose credential is an `Authorization: Bearer <token>` header. */
export type BearerScheme<TResult extends AuthenticationResult = AuthenticationResult> = {
	readonly kind: "bearer";
	readonly challenge?: BearerChallenge | undefined;
	readonly authenticate: Authenticator<TResult>;
};

/** A credential scheme descriptor, such as one {@link bearer} returns. */
export type CredentialScheme = BearerScheme<any>;

/**
 * The `authentication` field of `createRouta`: one principal schema and the credential schemes,
 * keyed by scheme name. Scheme names, descriptor kinds, and challenge overrides are contract facts
 * `routa generate` reads from source, so write them as literals.
 */
export type AuthenticationConfig = {
	readonly principal: PrincipalSchema;
	readonly schemes: Readonly<Record<string, CredentialScheme>>;
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
 * Compile-time checks for `createRouta`: every scheme's authenticated principal must be a valid
 * input of the principal schema, and a rejection carries no other fields.
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
						& (Exclude<
							keyof Exclude<ResultOf<TSchemes[K]>, { readonly type: "authenticated" }>,
							"type" | "principal"
						> extends never
							? unknown
							: {
									readonly 'A rejection is { type: "rejected" } with no other fields, so no failure detail reaches the response.': never;
								});
				};
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
	if (typeof options?.authenticate !== "function") {
		throw new TypeError("bearer() needs an authenticate function.");
	}

	const problem = challengeProblem(options.challenge);

	if (problem) {
		throw new TypeError(`bearer() ${problem}`);
	}

	return Object.freeze({
		kind: "bearer",
		...(options.challenge && { challenge: Object.freeze({ ...options.challenge }) }),
		authenticate: options.authenticate,
	});
}

/** Printable ASCII without `"` or `\`, so a realm never needs escaping in a quoted string. */
const realmPattern = /^[\x20\x21\x23-\x5b\x5d-\x7e]+$/;

/** Why a challenge override is invalid, or `undefined`. `routa check` reports the same rules. */
function challengeProblem(challenge: unknown): string | undefined {
	if (challenge === undefined) {
		return undefined;
	}

	if (typeof challenge !== "object" || challenge === null || Array.isArray(challenge)) {
		return 'challenge must be an object such as { realm: "api" }.';
	}

	const unknown = Object.keys(challenge).find((key) => key !== "realm");

	if (unknown !== undefined) {
		return `challenge declares "${unknown}". A Bearer challenge override accepts only realm.`;
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
	readonly kind: "bearer";
	readonly realm?: string | undefined;
	readonly authenticate: Authenticator<any>;
};

/** A validated `authentication` configuration. */
export type RuntimeAuthentication = {
	readonly principal: PrincipalSchema;
	/** In declaration order. */
	readonly schemes: readonly RuntimeScheme[];
};

/** Scheme names are OpenAPI security scheme keys, so they follow the component key rule. */
// A leading letter also keeps names out of JavaScript's integer-key ordering, so scheme order is
// the same in source, at runtime, and in generated metadata.
const schemeNamePattern = /^[a-zA-Z][a-zA-Z0-9.\-_]*$/;

/**
 * Validates an `authentication` configuration before the application serves traffic.
 * TypeScript and `routa check` report the same rules earlier; this keeps hand-built configs honest.
 *
 * @throws {TypeError} When the principal schema, a scheme name, or a descriptor is invalid, or two
 *   schemes read the same credential
 */
export function runtimeAuthentication(config: unknown): RuntimeAuthentication {
	const fail = (problem: string): never => {
		throw new TypeError(`createRouta authentication ${problem}`);
	};

	if (typeof config !== "object" || config === null || Array.isArray(config)) {
		return fail("must be an object with principal and schemes.");
	}

	const { principal, schemes } = config as { principal?: unknown; schemes?: unknown };

	if (
		typeof (principal as { safeParseAsync?: unknown } | undefined)?.safeParseAsync !== "function"
	) {
		fail("principal must be a Zod schema.");
	}

	if (typeof schemes !== "object" || schemes === null || Array.isArray(schemes)) {
		return fail("schemes must be an object keyed by scheme name.");
	}

	const runtime: RuntimeScheme[] = [];

	for (const [name, descriptor] of Object.entries(schemes)) {
		const scheme = descriptor as Partial<BearerScheme> | null;

		if (!schemeNamePattern.test(name)) {
			fail(
				`scheme name "${name}" must start with a letter and use only letters, digits, ".", "-", and "_".`,
			);
		}

		if (scheme?.kind !== "bearer" || typeof scheme.authenticate !== "function") {
			fail(`scheme "${name}" must be declared with bearer().`);
		}

		const problem = challengeProblem(scheme?.challenge);

		if (problem) {
			fail(`scheme "${name}" ${problem}`);
		}

		const earlier = runtime.find((item) => item.kind === scheme?.kind);

		if (earlier) {
			fail(
				`schemes "${earlier.name}" and "${name}" both read the Authorization Bearer credential. Verify every token format in one authenticator.`,
			);
		}

		runtime.push({
			name,
			kind: "bearer",
			realm: scheme?.challenge?.realm,
			authenticate: scheme!.authenticate!,
		});
	}

	if (runtime.length === 0) {
		fail("declares no credential schemes.");
	}

	return Object.freeze({
		principal: principal as PrincipalSchema,
		schemes: Object.freeze(runtime),
	});
}

/** A credential as the request presents it, before any authenticator runs. */
type Presented =
	| { readonly kind: "absent" }
	| { readonly kind: "unsupported" }
	| { readonly kind: "malformed" }
	| { readonly kind: "token"; readonly token: string };

// RFC 9110 separates an auth-scheme from its credential with spaces only.
const authSchemePattern = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+)(?: +(.*))?$/s;
/** RFC 6750 `b64token`. */
const tokenPattern = /^[A-Za-z0-9\-._~+/]+=*$/;

/**
 * Reads `Authorization`. Another authentication scheme is an unsupported credential; a Bearer
 * credential whose token is empty or not an RFC 6750 `b64token` is malformed.
 */
function presentedBearer(request: Request): Presented {
	const header = request.headers.get("authorization");

	if (header === null) {
		return { kind: "absent" };
	}

	const match = authSchemePattern.exec(header.trim());

	if (match?.[1]?.toLowerCase() !== "bearer") {
		return { kind: "unsupported" };
	}

	const token = match[2]?.trim() ?? "";
	return tokenPattern.test(token) ? { kind: "token", token } : { kind: "malformed" };
}

function bearerChallenge(scheme: RuntimeScheme, error?: "invalid_token"): string {
	const parameters = [
		...(scheme.realm === undefined ? [] : [`realm="${scheme.realm}"`]),
		...(error ? [`error="${error}"`] : []),
	];
	return parameters.length > 0 ? `Bearer ${parameters.join(", ")}` : "Bearer";
}

/** Challenges every scheme without error details, as for a missing or unsupported credential. */
function challengeAll(schemes: readonly RuntimeScheme[]): string {
	return schemes.map((scheme) => bearerChallenge(scheme)).join(", ");
}

/** The result of credential orchestration for one request. */
export type ResolvedAuthentication =
	| { readonly auth: AuthContext }
	| { readonly failed: { readonly challenge: string } };

const anonymous: AnonymousAuthContext = Object.freeze({ status: "anonymous" });

/**
 * Resolves one request's credential: anonymous without one; otherwise the scheme's authenticator
 * runs exactly once, and an accepted principal is parsed with the principal schema. A presented
 * credential that is malformed, unsupported, or rejected fails instead of becoming anonymous.
 *
 * @throws {AuthenticatorError} When the authenticator throws
 * @throws {AuthenticationContractError} When it returns an invalid result or principal
 */
export async function resolveAuthentication(
	authentication: RuntimeAuthentication,
	request: Request,
	context: { readonly logger: RoutaLogger; readonly services?: unknown },
): Promise<ResolvedAuthentication> {
	for (const scheme of authentication.schemes) {
		const presented = presentedBearer(request);

		if (presented.kind === "absent") {
			continue;
		}

		if (presented.kind === "unsupported") {
			return { failed: { challenge: challengeAll(authentication.schemes) } };
		}

		if (presented.kind === "malformed") {
			return { failed: { challenge: bearerChallenge(scheme, "invalid_token") } };
		}

		return await authenticate(authentication, scheme, presented.token, context);
	}

	return { auth: anonymous };
}

async function authenticate(
	authentication: RuntimeAuthentication,
	scheme: RuntimeScheme,
	token: string,
	context: { readonly logger: RoutaLogger; readonly services?: unknown },
): Promise<ResolvedAuthentication> {
	let result: unknown;

	try {
		result = await scheme.authenticate(
			token,
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
			typeof result === "object" && result !== null ? (result as { type?: unknown }).type : undefined;
	} catch {
		// A getter threw. Its error may carry the credential, or a ZodError the generic error mapping
		// would answer with 400 and its messages.
		throw new AuthenticationContractError(
			`Reading the result type from scheme "${scheme.name}" threw.`,
		);
	}

	if (type === "rejected") {
		return { failed: { challenge: bearerChallenge(scheme, "invalid_token") } };
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
	if (!isPrincipal(parsed.data)) {
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
 * The `authenticationFailed` result Routa selects for a failed credential, without a body on an
 * explicit HEAD operation.
 */
export function authenticationFailedResult(challenge: string, bodyless = false) {
	return {
		type: "authenticationFailed",
		...(bodyless ? {} : { data: authenticationFailedBody }),
		headers: { "www-authenticate": challenge },
	};
}

/**
 * Turns a `requireAuth` contract into the guard that enforces it on one route, or returns
 * `undefined` for any other middleware. The guard challenges every scheme it allows.
 *
 * @param label - Names the route in messages, such as `GET /orders`
 * @param bodyless - Whether the route is an explicit HEAD operation, whose outcomes have no body
 * @throws {Error} When authentication is not configured or the guard names an unknown scheme
 */
export function authenticationGuard(
	item: object,
	authentication: RuntimeAuthentication | undefined,
	label: string,
	bodyless = false,
):
	| {
			readonly rejects: {
				readonly authenticationRequired:
					| typeof authenticationRequiredOutcome
					| Omit<typeof authenticationRequiredOutcome, "schema">;
			};
			readonly run: (args: {
				ctx: Record<string, unknown>;
				next: () => Promise<object>;
			}) => unknown;
	  }
	| undefined {
	const requirement = requirements.get(item);

	if (!requirement) {
		return undefined;
	}

	if (!authentication) {
		throw new Error(
			`requireAuth() on ${label} needs authentication. Configure authentication in createRouta.`,
		);
	}

	const allowed = (requirement.schemes ?? authentication.schemes.map((scheme) => scheme.name)).map(
		(name) => {
			const scheme = authentication.schemes.find((item) => item.name === name);

			if (!scheme) {
				throw new Error(
					`requireAuth() on ${label} allows scheme "${name}", which createRouta authentication does not declare.`,
				);
			}

			return scheme;
		},
	);
	const challenge = challengeAll(allowed);
	const guard = Object.freeze({
		rejects: Object.freeze({
			authenticationRequired: bodyless
				? bodylessOutcome(authenticationRequiredOutcome)
				: authenticationRequiredOutcome,
		}),
		run: ({ ctx, next }: { ctx: Record<string, unknown>; next: () => Promise<object> }) =>
			(ctx.auth as AuthContext | undefined)?.status === "authenticated"
				? next()
				: {
						type: "authenticationRequired",
						...(bodyless ? {} : { data: authenticationRequiredBody }),
						headers: { "www-authenticate": challenge },
					},
	});
	requirements.set(guard, requirement);
	return guard;
}

/** Whether a middleware contract is a `requireAuth` guard. */
export function isAuthenticationGuard(item: object): boolean {
	return requirements.has(item);
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
