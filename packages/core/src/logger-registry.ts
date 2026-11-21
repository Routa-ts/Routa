/**
 * Marks loggers `createLogger` returned. Routa configuration accepts only these, so every event a
 * configured logger writes passes through the factory's sanitization before any sink sees it. The
 * key is a registered symbol, like `requireAuth`'s, so the CLI's copy of `@routa-ts/core`
 * recognizes a logger the application's copy created.
 */
const createdKey = Symbol.for("@routa-ts/core/createLogger");

/**
 * Where a created logger keeps the function that derives its request logger. A registered symbol,
 * for the same reason as the brand: the CLI's copy of `@routa-ts/core` binds request identity to a
 * logger the application's copy created.
 */
const requestLoggerKey = Symbol.for("@routa-ts/core/requestLogger");

/** Request identity fields, which a request logger binds so no event or child can replace them. */
export type RequestIdentityFields = Readonly<Record<string, string>>;

/**
 * Marks a logger as created by `createLogger` and freezes it, so its methods cannot be replaced.
 *
 * @param requestLogger - Derives the logger's request logger: a child whose identity fields no
 *   event data or later child binding replaces
 */
export function markCreatedLogger<TLogger extends object>(
	logger: TLogger,
	requestLogger: (identity: RequestIdentityFields) => TLogger,
): TLogger {
	Object.defineProperty(logger, createdKey, { value: true });
	Object.defineProperty(logger, requestLoggerKey, { value: requestLogger });
	return Object.freeze(logger);
}

/**
 * Derives request loggers from a logger `createLogger` created: each a child bound to one
 * request's identity fields, which its events and later children cannot replace. A disabled
 * logger's request logger is itself.
 *
 * @throws {TypeError} When the logger comes from a copy of `@routa-ts/core` that cannot bind request
 *   identity
 */
export function requestLoggers<TLogger extends object>(
	logger: TLogger,
): (identity: RequestIdentityFields) => TLogger {
	const derive = Object.getOwnPropertyDescriptor(logger, requestLoggerKey);

	if (!derive || !("value" in derive) || typeof derive.value !== "function") {
		throw new TypeError(
			"The configured logger comes from a copy of @routa-ts/core that cannot bind request identity. Install one version of @routa-ts/core for the application and the routa CLI.",
		);
	}

	return derive.value as (identity: RequestIdentityFields) => TLogger;
}

/**
 * Accepts only the own data property `createLogger` defines, holding `true`; no getter runs. An
 * object can still copy that key and value deliberately: the registered symbol keeps loggers from
 * another copy of the package acceptable, so it cannot also be a secret.
 *
 * @param where - What received the logger, which starts the error message
 * @param turnOff - How to turn logging off where the logger was received, which ends the message
 * @throws {TypeError} When `logger` is not a logger `createLogger` returned
 */
export function assertCreatedLogger(logger: unknown, where: string, turnOff: string): void {
	const brand =
		typeof logger === "object" && logger !== null
			? Object.getOwnPropertyDescriptor(logger, createdKey)
			: undefined;

	if (brand && "value" in brand && brand.value === true) {
		return;
	}

	throw new TypeError(
		`${where} a logger that createLogger did not create. Routa accepts only loggers from createLogger, so redaction runs before any output. Forward events to your backend from a sink instead: logger: createLogger({ sink: (event) => backend.write(event) }). ${turnOff}`,
	);
}
