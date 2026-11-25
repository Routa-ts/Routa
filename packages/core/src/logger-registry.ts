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
