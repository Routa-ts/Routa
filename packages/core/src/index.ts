import type { z } from "zod";
import type { RoutaLogger } from "./logger.js";
import type { reservedHeaders } from "./response-headers.js";

export type {
	CreateLoggerOptions,
	RoutaLogData,
	RoutaLogEvent,
	RoutaLogger,
	RoutaLogLevel,
	RoutaLogLevelWithSilent,
} from "./logger.js";
export { createLogger } from "./logger.js";

export type HttpMethod = "get" | "post" | "put" | "patch" | "delete" | "head";

export type SchemaInput<TSchema> = TSchema extends z.ZodTypeAny ? z.input<TSchema> : never;
export type SchemaOutput<TSchema> = TSchema extends z.ZodTypeAny ? z.output<TSchema> : never;

export type RouteInput = {
	params?: z.ZodTypeAny;
	query?: z.ZodTypeAny;
	headers?: z.ZodTypeAny;
	cookies?: z.ZodTypeAny;
	body?: z.ZodTypeAny;
};

/**
 * A named outcome: its HTTP status, an optional description, an optional JSON body schema,
 * and optional response headers.
 *
 * An outcome without `schema` is intentionally bodyless. `headers` is a Zod object keyed by
 * lowercase header names whose values are strings, numbers, or booleans.
 */
export type RouteOutcome = {
	status: number;
	description?: string;
	schema?: z.ZodTypeAny;
	headers?: z.ZodObject<any, any>;
};

export type RouteResponses = Record<string, RouteOutcome>;
export type ExternalApiUrl = `http://${string}` | `https://${string}`;
export type ResponseValidation = "development" | "always";
export type RegisteredRoutePath = keyof RegisteredRouteCtxByPath & `/${string}`;
export type RouteDeprecationReplacement = RegisteredRoutePath | ExternalApiUrl;
export type RouteDeprecation = {
	sunset?: string;
	replacement?: RouteDeprecationReplacement;
};
export type MiddlewareRejectsSpec = RouteResponses;

type MaybePromise<T> = T | Promise<T>;

/**
 * The type of `data` on a schema-less outcome. It requires a property whose type is `never`, so no
 * value can satisfy it, and the property name carries the compiler message: the message is a missing
 * key, never a value that `data` could hold.
 */
type ForbiddenData<TName extends string> = {
	readonly [K in `Outcome ${TName} declares no schema, so it cannot return data.`]: never;
};

/** The type of `headers` on an outcome that declares none; see {@link ForbiddenData}. */
type HeadersNotDeclared<TName extends string> = {
	readonly [K in `Outcome ${TName} declares no headers, so it cannot return headers.`]: never;
};

/** The `headers` result field: required when any declared header is required, forbidden when none are declared. */
type OutcomeHeaders<TName extends string, TOutcome> = TOutcome extends {
	readonly headers: infer THeaders extends z.ZodTypeAny;
}
	? {} extends SchemaOutput<THeaders>
		? { readonly headers?: SchemaOutput<THeaders> }
		: { readonly headers: SchemaOutput<THeaders> }
	: { readonly headers?: HeadersNotDeclared<TName> };

/**
 * The handler result for one outcome: body outcomes require `data`, schema-less outcomes forbid it.
 * An explicit `data: undefined` is accepted and means no data, because TypeScript cannot tell it
 * from an omitted property unless `exactOptionalPropertyTypes` is on. `headers` follows the same
 * rule: required or optional from the declared headers, and forbidden when none are declared.
 */
export type OutcomeResult<TName extends string, TOutcome> = (TOutcome extends {
	readonly schema: infer TSchema extends z.ZodTypeAny;
}
	? { readonly type: TName; readonly data: SchemaOutput<TSchema> }
	: { readonly type: TName; readonly data?: ForbiddenData<TName> })
	& OutcomeHeaders<TName, TOutcome>;

/** `true` when any member of a union of booleans is `true`. */
type AnyTrue<T> = true extends T ? true : false;

/**
 * Whether a response schema, or anything nested in it, rewrites a value by a wrapper TypeScript can see:
 * transforms, codecs, defaults, and catches. Nesting beyond eight levels is not inspected.
 */
type ChangesValue<TSchema, TDepth extends unknown[] = []> = TDepth["length"] extends 8
	? false
	: TSchema extends
				| z.ZodTransform
				| z.ZodCodec<any, any>
				| z.ZodDefault<any>
				| z.ZodPrefault<any>
				| z.ZodCatch<any>
		? true
		: TSchema extends z.ZodPipe<infer TIn, infer TOut>
			? AnyTrue<ChangesValue<TIn, [...TDepth, 0]> | ChangesValue<TOut, [...TDepth, 0]>>
			: TSchema extends z.ZodObject<infer TShape, any>
				? AnyTrue<{ [K in keyof TShape]: ChangesValue<TShape[K], [...TDepth, 0]> }[keyof TShape]>
				: TSchema extends z.ZodArray<infer TElement>
					? ChangesValue<TElement, [...TDepth, 0]>
					: TSchema extends z.ZodOptional<infer TInner>
						? ChangesValue<TInner, [...TDepth, 0]>
						: TSchema extends z.ZodNullable<infer TInner>
							? ChangesValue<TInner, [...TDepth, 0]>
							: TSchema extends z.ZodReadonly<infer TInner>
								? ChangesValue<TInner, [...TDepth, 0]>
								: TSchema extends z.ZodUnion<infer TOptions>
									? AnyTrue<ChangesValue<TOptions[number], [...TDepth, 0]>>
									: TSchema extends z.ZodIntersection<infer TLeft, infer TRight>
										? AnyTrue<
												ChangesValue<TLeft, [...TDepth, 0]> | ChangesValue<TRight, [...TDepth, 0]>
											>
										: TSchema extends z.ZodRecord<any, infer TValue>
											? ChangesValue<TValue, [...TDepth, 0]>
											: TSchema extends z.ZodTuple<infer TItems>
												? AnyTrue<ChangesValue<TItems[number], [...TDepth, 0]>>
												: false;

/** Whether a schema parses to the same type it accepts. */
type SameValueType<TSchema extends z.ZodTypeAny> = [z.input<TSchema>] extends [z.output<TSchema>]
	? [z.output<TSchema>] extends [z.input<TSchema>]
		? true
		: false
	: false;

/** A message under `TKey` when a schema changes values, else `unknown`, which adds no constraint. */
type SchemaProblem<TSchema, TKey extends string> = TSchema extends z.ZodTypeAny
	? SameValueType<TSchema> extends false
		? ValueChangeMessage<TKey>
		: ChangesValue<TSchema> extends false
			? unknown
			: ValueChangeMessage<TKey>
	: unknown;

type ValueChangeMessage<TKey extends string> = {
	[
		K in TKey
	]: "Response schemas describe wire-ready JSON and must not change values. Remove transforms, pipes, defaults, catches, and coercion, and return the final value from the handler.";
};

/** Header names Routa owns on every response. */
type ReservedHeaderName = (typeof reservedHeaders)[number];

type HeaderNameProblem<TName extends string> = TName extends ReservedHeaderName
	? `Header "${TName}" is reserved: Routa owns it, so an outcome cannot declare it.`
	: TName extends Lowercase<TName>
		? never
		: `Header "${TName}" must be declared in lowercase ("${Lowercase<TName>}").`;

type HeaderValueProblem<TName extends string, TSchema> = TSchema extends z.ZodTypeAny
	? [Exclude<z.output<TSchema>, undefined>] extends [string | number | boolean]
		? never
		: `Header "${TName}" must be a string, number, or boolean schema (or a literal or enum of them).`
	: never;

type HeaderEntryProblem<TName, TSchema> = TName extends string
	? HeaderNameProblem<TName> | HeaderValueProblem<TName, TSchema>
	: never;

type HeadersProblem<THeaders> =
	THeaders extends z.ZodObject<infer TShape, any>
		? [{ [K in keyof TShape]: HeaderEntryProblem<K, TShape[K]> }[keyof TShape]] extends [never]
			? SchemaProblem<THeaders, "headers">
			: { headers: { [K in keyof TShape]: HeaderEntryProblem<K, TShape[K]> }[keyof TShape] }
		: unknown;

type StatusProblem<TStatus, TOutcome> = TStatus extends number
	? `${TStatus}` extends `1${string}`
		? {
				status: "Informational (1xx) statuses cannot be terminal route outcomes. Use a final status from 200 to 599.";
			}
		: TStatus extends 204 | 205 | 304
			? TOutcome extends { readonly schema: unknown }
				? {
						schema: `Status ${TStatus} responses have no body, so the outcome cannot declare a schema.`;
					}
				: unknown
			: unknown
	: unknown;

type OutcomeChecks<TOutcome> = StatusProblem<
	TOutcome extends { readonly status: infer TStatus } ? TStatus : never,
	TOutcome
>
	& (TOutcome extends { readonly schema: infer TSchema }
		? SchemaProblem<TSchema, "schema">
		: unknown)
	& (TOutcome extends { readonly headers: infer THeaders } ? HeadersProblem<THeaders> : unknown);

/** Compile-time checks for declared outcomes; valid outcomes add no constraint. */
export type ResponseChecks<TResponses extends RouteResponses> = {
	readonly [K in keyof TResponses]: OutcomeChecks<TResponses[K]>;
};

export type RoutaResult<TResponses extends RouteResponses> = {
	[K in keyof TResponses & string]: OutcomeResult<K, TResponses[K]>;
}[keyof TResponses & string];

export type RouteRunResult<TResponses extends RouteResponses> = RoutaResult<TResponses>;

/** The trailing builder argument for declared headers: required, optional, or absent. */
type BuilderHeaderArgs<TOutcome> = TOutcome extends {
	readonly headers: infer THeaders extends z.ZodTypeAny;
}
	? {} extends SchemaOutput<THeaders>
		? [headers?: SchemaOutput<THeaders>]
		: [headers: SchemaOutput<THeaders>]
	: [];

/**
 * Pure result builders keyed by the route's declared outcome names. A body outcome takes its data,
 * then its headers when it declares any; a bodyless outcome takes only its headers.
 */
export type ResponseBuilders<TResponses extends RouteResponses> = {
	readonly [K in keyof TResponses & string]: TResponses[K] extends {
		readonly schema: infer TSchema extends z.ZodTypeAny;
	}
		? (
				data: SchemaOutput<TSchema>,
				...headers: BuilderHeaderArgs<TResponses[K]>
			) => Extract<OutcomeResult<K, TResponses[K]>, { readonly data: unknown }>
		: (...headers: BuilderHeaderArgs<TResponses[K]>) => OutcomeResult<K, TResponses[K]>;
};

export type MiddlewareRejectResult<TRejects extends MiddlewareRejectsSpec> =
	keyof TRejects extends never ? never : RoutaResult<TRejects>;

export type MiddlewareProvidesSpec = Record<string, z.ZodTypeAny>;
export type MiddlewareOpenApi = {
	security?: readonly Record<string, readonly string[]>[];
	permissions?: readonly string[];
};

export type MiddlewareProvidesKeys<TProvides extends MiddlewareProvidesSpec> = keyof TProvides
	& string;

export type MiddlewareProvidedCtx<TProvides extends MiddlewareProvidesSpec> = {
	[K in keyof TProvides]: SchemaOutput<TProvides[K]>;
};

export type MiddlewareNext<
	TProvides extends MiddlewareProvidesSpec,
	TRejects extends MiddlewareRejectsSpec,
> = keyof TProvides extends never
	? (ctx?: MiddlewareProvidedCtx<TProvides>) => Promise<MiddlewareRejectResult<TRejects>>
	: (ctx: MiddlewareProvidedCtx<TProvides>) => Promise<MiddlewareRejectResult<TRejects>>;

export type MiddlewareRunArgs<
	TRequires extends readonly RegisteredCtxKey[],
	TProvides extends MiddlewareProvidesSpec,
	TRejects extends MiddlewareRejectsSpec,
	TInput extends RouteInput | undefined,
> = {
	input: InferInput<TInput>;
	ctx: RequiredMiddlewareCtx<TRequires>;
	next: MiddlewareNext<TProvides, TRejects>;
};

export type MiddlewareRun<
	TRequires extends readonly RegisteredCtxKey[],
	TProvides extends MiddlewareProvidesSpec,
	TRejects extends MiddlewareRejectsSpec,
	TInput extends RouteInput | undefined,
> = (
	args: MiddlewareRunArgs<TRequires, TProvides, TRejects, TInput>,
) => MaybePromise<MiddlewareRejectResult<NoInfer<TRejects>>>;

export type MiddlewareContract<
	TRequires extends readonly RegisteredCtxKey[] = readonly RegisteredCtxKey[],
	TProvides extends MiddlewareProvidesSpec = Record<never, never>,
	TRejects extends MiddlewareRejectsSpec = Record<never, never>,
	TInput extends RouteInput | undefined = RouteInput | undefined,
> = {
	requires?: TRequires;
	provides?: TProvides;
	rejects?: TRejects;
	input?: TInput;
	openapi?: MiddlewareOpenApi;
	run?: MiddlewareRun<TRequires, TProvides, TRejects, TInput>;
};

export type AnyMiddlewareContract = Omit<MiddlewareContract<any, any, any, any>, "run"> & {
	run?: (args: any) => unknown;
};

type RegisteredCtxByKey = Register extends {
	ctxByKey: infer TCtxByKey;
}
	? TCtxByKey extends Record<string, unknown>
		? TCtxByKey
		: Record<string, unknown>
	: Record<string, unknown>;

type RegisteredCtxKey = keyof RegisteredCtxByKey & string;

type RequiredMiddlewareCtx<TRequires extends readonly string[]> = {
	[K in TRequires[number]]: K extends keyof RegisteredCtxByKey ? RegisteredCtxByKey[K] : unknown;
};

export type MiddlewareProvides<TMiddleware extends readonly AnyMiddlewareContract[]> =
	TMiddleware[number] extends MiddlewareContract<any, infer TProvides>
		? MiddlewareProvidesKeys<TProvides>
		: never;

type UnionToIntersection<T> = (T extends unknown ? (value: T) => void : never) extends (
	value: infer TResult,
) => void
	? TResult
	: never;

export type InferMiddlewareCtx<TMiddleware extends readonly AnyMiddlewareContract[]> =
	UnionToIntersection<
		TMiddleware[number] extends MiddlewareContract<any, infer TProvides>
			? MiddlewareProvidedCtx<TProvides>
			: unknown
	>;

/**
 * Parsed route input after Zod validation.
 *
 * Each field uses {@link SchemaOutput} (Zod's output / parsed type), not
 * {@link SchemaInput}, because handlers and middleware receive validated values.
 */
export type InferInput<TInput extends RouteInput | undefined> = {
	[K in keyof NonNullable<TInput>]: SchemaOutput<NonNullable<TInput>[K]>;
};

export type InferResponse<TResponses extends RouteResponses> = RouteRunResult<TResponses>;

/**
 * Framework-owned values available to every route handler.
 *
 * `logger` is always present. When logging is disabled in Routa configuration,
 * it is a no-op logger so handlers do not need configuration-dependent guards.
 */
export type RoutaRouteContext = {
	readonly logger: RoutaLogger;
};

export type RouteHandlerArgs<
	TInput extends RouteInput | undefined,
	TCtx,
	TResponses extends RouteResponses = RouteResponses,
> = {
	input: InferInput<TInput>;
	ctx: Omit<TCtx, keyof RoutaRouteContext> & RoutaRouteContext;
	response: ResponseBuilders<TResponses>;
};

export type RouteRun<
	TInput extends RouteInput | undefined,
	TResponses extends RouteResponses,
	TCtx,
> = (
	args: RouteHandlerArgs<TInput, TCtx, NoInfer<TResponses>>,
) => MaybePromise<RouteRunResult<NoInfer<TResponses>>>;

export type RouteContract<
	TInput extends RouteInput | undefined,
	TResponses extends RouteResponses,
	TCtx,
	TMiddleware extends readonly AnyMiddlewareContract[] = readonly AnyMiddlewareContract[],
> = {
	input?: TInput;
	responses: TResponses;
	middleware?: TMiddleware;
	deprecation?: RouteDeprecation;
	run: RouteRun<TInput, TResponses, TCtx>;
};

export type AnyRouteContract = {
	input?: RouteInput;
	responses: RouteResponses;
	middleware?: readonly AnyMiddlewareContract[];
	deprecation?: RouteDeprecation;
	run: (args: any) => unknown;
};

export type ContextualRouteContract<TCtx> = RouteContract<
	any,
	any,
	TCtx,
	readonly AnyMiddlewareContract[]
>;

export type RouteRootConfigForCtx<TCtxByMethod extends Partial<Record<HttpMethod, unknown>>> = {
	middleware?: readonly AnyMiddlewareContract[];
} & {
	[K in HttpMethod]?: ContextualRouteContract<CtxForMethod<TCtxByMethod, K>>;
};

type NoExtraRouteKeys<TConfig> = Record<Exclude<keyof TConfig, HttpMethod | "middleware">, never>;

type MethodOutcomeProblem<TMethod, TOutcome> = TMethod extends "head"
	? TOutcome extends { readonly schema: unknown }
		? { schema: "HEAD responses have no body, so a HEAD outcome cannot declare a schema." }
		: unknown
	: TMethod extends "get"
		? unknown
		: TOutcome extends { readonly status: 304 }
			? { status: "Status 304 is valid only for GET and HEAD routes." }
			: unknown;

/** Compile-time checks that depend on the HTTP method a route is registered under. */
type MethodRules<TConfig> = {
	readonly [K in keyof TConfig & HttpMethod]: TConfig[K] extends {
		readonly responses: infer TResponses;
	}
		? {
				readonly responses: {
					readonly [N in keyof TResponses]: MethodOutcomeProblem<K, TResponses[N]>;
				};
			}
		: unknown;
};

type CtxForMethod<TCtxByMethod, TMethod extends HttpMethod> = TMethod extends keyof TCtxByMethod
	? TCtxByMethod[TMethod]
	: unknown;

// Augmented by generated .routa/routes.gen.ts files.
export interface Register {}

type RegisteredRouteCtxByPath = Register extends {
	routeCtxByPath: infer TRouteCtxByPath;
}
	? TRouteCtxByPath extends Record<string, Partial<Record<HttpMethod, unknown>>>
		? TRouteCtxByPath
		: Record<string, Partial<Record<HttpMethod, unknown>>>
	: Record<string, Partial<Record<HttpMethod, unknown>>>;

export type RoutaConfig = {
	host?: string;
	port?: number;
	logger?: RoutaLogger | false;
	lifecycleHeaders?: boolean;
	/** Defaults to `"development"`, which skips response schema parsing during `routa start`. */
	responseValidation?: ResponseValidation;
};

/**
 * Preserves a Routa configuration object.
 *
 * @param config - The Routa configuration to use
 * @returns The provided configuration with Routa configuration typing
 */
export function createRouta<const TConfig extends RoutaConfig>(
	config: TConfig,
): TConfig & RoutaConfig {
	return config;
}

/**
 * Preserves a route contract with its inferred types.
 *
 * @param contract - The route contract to preserve
 * @returns The same route contract
 */
export function createRoute<
	const TInput extends RouteInput | undefined,
	const TResponses extends RouteResponses,
	const TMiddleware extends readonly AnyMiddlewareContract[] = readonly AnyMiddlewareContract[],
	TCtx = InferMiddlewareCtx<TMiddleware>,
>(
	contract: RouteContract<TInput, TResponses, TCtx, TMiddleware> & {
		readonly responses: ResponseChecks<NoInfer<TResponses>>;
	},
): RouteContract<TInput, NoInfer<TResponses>, TCtx, TMiddleware> {
	return contract;
}

/**
 * Creates a route definition factory that binds route configs to an explicit
 * per-path context map.
 *
 * Prefer {@link createRouteRoot} in app code: it reads context types from the
 * generated `Register` augmentation in `.routa/routes.gen.ts`. Use this factory
 * when you need the same path-bound helper against a custom `TCtxByPath` map
 * (for example in tests, libraries, or tooling that does not rely on `Register`).
 *
 * @returns A function that accepts a route path and returns a config helper for that path.
 */
export function createRouteRootFactory<
	TCtxByPath extends Record<string, Partial<Record<HttpMethod, unknown>>>,
>() {
	return function createRouteRoot<const TPath extends keyof TCtxByPath & string>(_path: TPath) {
		return function routeRoot<
			const TConfig extends RouteRootConfigForCtx<TCtxByPath[TPath]>
				& NoExtraRouteKeys<TConfig>
				& MethodRules<TConfig>,
		>(config: TConfig): TConfig {
			return config;
		};
	};
}

/**
 * Creates a route definition factory for a specific path.
 *
 * @param _path - The route path used to select the matching context type
 * @returns A function that accepts a route configuration for the selected path
 */
export function createRouteRoot<const TPath extends keyof RegisteredRouteCtxByPath & string>(
	_path: TPath,
) {
	return function routeRoot<
		const TConfig extends RouteRootConfigForCtx<RegisteredRouteCtxByPath[TPath]>
			& NoExtraRouteKeys<TConfig>
			& MethodRules<TConfig>,
	>(config: TConfig): TConfig {
		return config;
	};
}

/**
 * Preserves a middleware contract's type information.
 *
 * @param contract - The middleware contract to preserve
 * @returns The provided middleware contract
 */
export function createMiddleware<
	const TRequires extends readonly RegisteredCtxKey[] = readonly RegisteredCtxKey[],
	const TProvides extends MiddlewareProvidesSpec = Record<never, never>,
	const TRejects extends MiddlewareRejectsSpec = Record<never, never>,
	const TInput extends RouteInput | undefined = undefined,
>(
	contract: MiddlewareContract<TRequires, TProvides, TRejects, TInput> & {
		readonly rejects?: ResponseChecks<NoInfer<TRejects>>;
	},
): MiddlewareContract<TRequires, TProvides, TRejects, TInput> {
	return contract;
}
