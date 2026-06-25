import type { z } from "zod";

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

export type MiddlewareContract<
	TRequires extends readonly string[] = readonly string[],
	TProvides extends readonly string[] = readonly string[],
	TRejects extends readonly string[] = readonly string[],
	TInput extends RouteInput | undefined = RouteInput | undefined,
> = {
	requires?: TRequires;
	provides?: TProvides;
	rejects?: TRejects;
	input?: TInput;
};

export type MiddlewareProvides<TMiddleware extends readonly MiddlewareContract[]> =
	TMiddleware[number] extends MiddlewareContract<readonly string[], infer TProvides>
		? TProvides[number]
		: never;

export type InferMiddlewareCtx<TMiddleware extends readonly MiddlewareContract[]> = {
	[K in MiddlewareProvides<TMiddleware>]: unknown;
};

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
	TMiddleware extends readonly MiddlewareContract[] = readonly MiddlewareContract[],
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
	middleware?: readonly MiddlewareContract[];
	run: unknown;
};

export type DefineRouteConfig = Partial<Record<HttpMethod, AnyRouteContract>> & {
	params?: z.ZodTypeAny;
	middleware?: readonly MiddlewareContract[];
	methods?: Partial<Record<HttpMethod, AnyRouteContract>>;
};

export function createRoute<
	const TInput extends RouteInput | undefined,
	const TResponses extends RouteResponses,
	const TMiddleware extends readonly MiddlewareContract[] = readonly MiddlewareContract[],
	TCtx = InferMiddlewareCtx<TMiddleware>,
>(
	contract: RouteContract<TInput, TResponses, TCtx, TMiddleware>,
): RouteContract<TInput, TResponses, TCtx, TMiddleware> {
	return contract;
}

export function defineRoute<const TConfig extends DefineRouteConfig>(config: TConfig): TConfig {
	return config;
}

export function createMiddleware<
	const TRequires extends readonly string[] = readonly string[],
	const TProvides extends readonly string[] = readonly string[],
	const TRejects extends readonly string[] = readonly string[],
	const TInput extends RouteInput | undefined = undefined,
>(
	contract: MiddlewareContract<TRequires, TProvides, TRejects, TInput>,
): MiddlewareContract<TRequires, TProvides, TRejects, TInput> {
	return contract;
}
