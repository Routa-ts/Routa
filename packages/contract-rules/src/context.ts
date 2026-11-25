/** Why Routa reserves a context key, and what to do instead of claiming it. */
export type ReservedContextKey = {
	/** Follows "which Routa reserves for". */
	readonly reason: string;
	readonly advice: string;
};

/**
 * The context keys Routa reserves, which no middleware can provide or pass to `next()`. A
 * low-level route's `createContext` fails the request only when it returns `services`; Routa
 * replaces the other keys it returns with its own.
 */
export const reservedContext: Readonly<
	Record<"services" | "requestId" | "correlationId" | "logger", ReservedContextKey>
> = {
	services: {
		reason: "injected services",
		advice:
			"Rename the context key. To share an application dependency, declare it as an application service.",
	},
	requestId: {
		reason: "the request identity it generates",
		advice:
			"Rename the context key. Every middleware, route-file and method services factory, and handler already reads ctx.requestId.",
	},
	correlationId: {
		reason: "the correlation ID it accepts",
		advice:
			"Rename the context key. Configure correlation in createRouta, and read the accepted value as ctx.correlationId.",
	},
	logger: {
		reason: "the request logger",
		advice:
			"Rename the context key. Handlers and services factories receive the request logger as ctx.logger.",
	},
};

/** `ctx.auth`, which Routa reserves only when the application configures authentication. */
export const reservedAuthContext: ReservedContextKey = {
	reason: "authentication",
	advice: "Rename the context key. Routa resolves ctx.auth from the request's credential.",
};
