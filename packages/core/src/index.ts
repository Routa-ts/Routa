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

export type MiddlewareProvidesSpec = Record<string, z.ZodTypeAny>;

export type MiddlewareProvidesKeys<TProvides extends MiddlewareProvidesSpec> = keyof TProvides &
	string;

export type MiddlewareProvidedCtx<TProvides extends MiddlewareProvidesSpec> = {
	[K in keyof TProvides]: SchemaOutput<TProvides[K]>;
};

export type MiddlewareContract<
	TRequires extends readonly RegisteredCtxKey[] = readonly RegisteredCtxKey[],
	TProvides extends MiddlewareProvidesSpec = Record<string, z.ZodTypeAny>,
	TRejects extends readonly string[] = readonly string[],
	TInput extends RouteInput | undefined = RouteInput | undefined,
> = {
	requires?: TRequires;
	provides?: TProvides;
	rejects?: TRejects;
	input?: TInput;
	run?: (args: {
		input: InferInput<TInput>;
		ctx: RequiredMiddlewareCtx<TRequires>;
		next: (ctx?: MiddlewareProvidedCtx<TProvides>) => Promise<
			| {
					type: TRejects[number];
					data: unknown;
			  }
			| unknown
		>;
	}) =>
		| Promise<
				| {
						type: TRejects[number];
						data: unknown;
				  }
				| unknown
		  >
		| {
				type: TRejects[number];
				data: unknown;
		  }
		| unknown;
};

export type AnyMiddlewareContract = MiddlewareContract<any, any, any, any>;

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

export type InferInput<TInput extends RouteInput | undefined> = {
	[K in keyof NonNullable<TInput>]: SchemaOutput<NonNullable<TInput>[K]>;
};

export type InferResponse<TResponses extends RouteResponses> = {
	[K in keyof TResponses]: {
		type: K;
		data: SchemaOutput<TResponses[K]["schema"]>;
	};
}[keyof TResponses];

export type RouteHandlerArgs<TInput extends RouteInput | undefined, TCtx> = {
	input: InferInput<TInput>;
	ctx: TCtx;
};

export type RouteContract<
	TInput extends RouteInput | undefined,
	TResponses extends RouteResponses,
	TCtx,
	TMiddleware extends readonly AnyMiddlewareContract[] = readonly AnyMiddlewareContract[],
> = {
	input?: TInput;
	responses: TResponses;
	middleware?: TMiddleware;
	run: (
		args: RouteHandlerArgs<TInput, TCtx>,
	) => InferResponse<TResponses> | Promise<InferResponse<TResponses>>;
};

export type AnyRouteContract = {
	input?: RouteInput;
	responses: RouteResponses;
	middleware?: readonly AnyMiddlewareContract[];
	run: unknown;
};

export type DefineRouteConfig = Partial<Record<HttpMethod, AnyRouteContract>> & {
	params?: z.ZodTypeAny;
	middleware?: readonly AnyMiddlewareContract[];
	methods?: Partial<Record<HttpMethod, AnyRouteContract>>;
};

export type ContextualRouteContract<TCtx> = RouteContract<
	any,
	any,
	TCtx,
	readonly AnyMiddlewareContract[]
>;

export type DefineRouteConfigForCtx<TCtxByMethod extends Partial<Record<HttpMethod, unknown>>> = {
	params?: z.ZodTypeAny;
	middleware?: readonly AnyMiddlewareContract[];
	methods?: {
		[K in HttpMethod]?: ContextualRouteContract<CtxForMethod<TCtxByMethod, K>>;
	};
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
};

export function createRouta<const TConfig extends RoutaConfig>(
	config: TConfig,
): TConfig & RoutaConfig {
	return config;
}

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

export function defineRoute<const TConfig extends DefineRouteConfig>(config: TConfig): TConfig {
	return config;
}

export function createRouteRootFactory<
	TCtxByPath extends Record<string, Partial<Record<HttpMethod, unknown>>>,
>() {
	return function createRouteRoot<const TPath extends keyof TCtxByPath & string>(_path: TPath) {
		return function defineRouteForPath<
			const TConfig extends DefineRouteConfigForCtx<TCtxByPath[TPath]>,
		>(config: TConfig): TConfig {
			return config;
		};
	};
}

export function createRouteRoot<const TPath extends keyof RegisteredRouteCtxByPath & string>(
	_path: TPath,
) {
	return function defineRouteForPath<
		const TConfig extends DefineRouteConfigForCtx<RegisteredRouteCtxByPath[TPath]>,
	>(config: TConfig): TConfig {
		return config;
	};
}

export function createMiddleware<
	const TRequires extends readonly RegisteredCtxKey[] = readonly RegisteredCtxKey[],
	const TProvides extends MiddlewareProvidesSpec = Record<string, z.ZodTypeAny>,
	const TRejects extends readonly string[] = readonly string[],
	const TInput extends RouteInput | undefined = undefined,
>(
	contract: MiddlewareContract<TRequires, TProvides, TRejects, TInput>,
): MiddlewareContract<TRequires, TProvides, TRejects, TInput> {
	return contract;
}
