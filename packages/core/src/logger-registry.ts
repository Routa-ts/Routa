/**
 * Marks loggers `createLogger` returned. Routa configuration accepts only these, so every event a
 * configured logger writes passes through the factory's sanitization before any sink sees it. The
 * key is a registered symbol, like `requireAuth`'s, so the CLI's copy of `@routa-ts/core`
 * recognizes a logger the application's copy created.
 */
const createdKey = Symbol.for("@routa-ts/core/createLogger");

/** Marks a logger as created by `createLogger` and freezes it, so its methods cannot be replaced. */
export function markCreatedLogger<TLogger extends object>(logger: TLogger): TLogger {
	Object.defineProperty(logger, createdKey, { value: true });
	return Object.freeze(logger);
}

/**
 * @param where - What received the logger, which starts the error message
 * @throws {TypeError} When `logger` is not a logger `createLogger` returned
 */
export function assertCreatedLogger(logger: unknown, where: string): void {
	if (typeof logger === "object" && logger !== null && Object.hasOwn(logger, createdKey)) {
		return;
	}

	throw new TypeError(
		`${where} a logger that createLogger did not create. Routa accepts only loggers from createLogger, so redaction runs before any output. Forward events to your backend from a sink instead: logger: createLogger({ sink: (event) => backend.write(event) }). Set logger: false to turn logging off.`,
	);
}
