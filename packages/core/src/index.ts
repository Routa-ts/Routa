import type { z } from "zod";
import type { RoutaLogger } from "./logger.js";

export type {
	CreateLoggerOptions,
	RoutaLogData,
	RoutaLogEvent,
	RoutaLogger,
} from "./logger.js";
export { createLogger } from "./logger.js";

export type HttpMethod = "get" | "post" | "put" | "patch" | "delete" | "head" | "options";

export type SchemaInput<TSchema> = TSchema extends z.ZodTypeAny ? z.input<TSchema> : never;
export type SchemaOutput<TSchema> = TSchema extends z.ZodTypeAny ? z.output<TSchema> : never;

export type RouteInput = {
	params?: z.ZodTypeAny;
	query?: z.ZodTypeAny;
	headers?: z.ZodTypeAny;
	cookies?: z.ZodTypeAny;
	body?: z.ZodTypeAny;
};

export type RouteResponses = Record<
	string,
	{
		status: number;
		schema: z.ZodTypeAny;
	}
>;
export type ExternalApiUrl = `http://${string}` | `https://${string}`;
export type RegisteredRoutePath = keyof RegisteredRouteCtxByPath & `/${string}`;
export type RouteDeprecationReplacement = RegisteredRoutePath | ExternalApiUrl;
export type RouteDeprecation = {
	sunset?: string;
	replacement?: RouteDeprecationReplacement;
};
export type MiddlewareRejectsSpec = RouteResponses;

type MaybePromise<T> = T | Promise<T>;

export type RoutaResult<TResponses extends RouteResponses> = {
	[K in keyof TResponses & string]: {
		readonly type: K;
		readonly data: SchemaOutput<TResponses[K]["schema"]>;
	};
}[keyof TResponses & string];

export type RouteRunResult<TResponses extends RouteResponses> = RoutaResult<TResponses>;

type WidenedRouteRunResult<TResponses extends RouteResponses> = {
	readonly type: string;
	readonly data: SchemaOutput<TResponses[keyof TResponses & string]["schema"]>;
};

type RouteRunReturn<TResponses extends RouteResponses> =
	| RouteRunResult<TResponses>
	| WidenedRouteRunResult<TResponses>;

export type MiddlewareRejectResult<TRejects extends MiddlewareRejectsSpec> =
	keyof TRejects extends never ? never : RoutaResult<TRejects>;

export type MiddlewareProvidesSpec = Record<string, z.ZodTypeAny>;
export type MiddlewareOpenApi = {
	security?: readonly Record<string, readonly string[]>[];
	permissions?: readonly string[];
};

export type MiddlewareProvidesKeys<TProvides extends MiddlewareProvidesSpec> = keyof TProvides &
	string;

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

export type RouteHandlerArgs<TInput extends RouteInput | undefined, TCtx> = {
	input: InferInput<TInput>;
	ctx: TCtx;
};

export type RouteRun<
	TInput extends RouteInput | undefined,
	TResponses extends RouteResponses,
	TCtx,
> = (args: RouteHandlerArgs<TInput, TCtx>) => MaybePromise<RouteRunReturn<NoInfer<TResponses>>>;

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

type CtxForMethod<TCtxByMethod, TMethod extends HttpMethod> = TMethod extends keyof TCtxByMethod
	? TCtxByMethod[TMethod]
	: unknown;

// biome-ignore lint/suspicious/noEmptyInterface: Augmented by generated .routa/routes.gen.ts files.
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
	contract: RouteContract<TInput, TResponses, TCtx, TMiddleware>,
): RouteContract<TInput, TResponses, TCtx, TMiddleware> {
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
		return function routeRoot<const TConfig extends RouteRootConfigForCtx<TCtxByPath[TPath]>>(
			config: TConfig,
		): TConfig {
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
		const TConfig extends RouteRootConfigForCtx<RegisteredRouteCtxByPath[TPath]>,
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
	contract: MiddlewareContract<TRequires, TProvides, TRejects, TInput>,
): MiddlewareContract<TRequires, TProvides, TRejects, TInput> {
	return contract;
}
