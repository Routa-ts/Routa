import { createLogger, type RoutaLogLevelWithSilent, type RoutaLogSink } from "@routa-ts/core";
import pino, { type Logger } from "pino";
import pretty from "pino-pretty";

/**
 * Forwards each event to Pino at the same level. Routa has already redacted, escaped, and bounded
 * the event, so the sink only chooses the output.
 */
export function pinoSink(output: Logger): RoutaLogSink {
	return ({ level, event, message, data }) => output[level]({ ...data, event }, message);
}

/**
 * The application's Pino instance, which the application owns: its destination, buffering,
 * flushing, and shutdown. Development uses pino-pretty for readable terminal output; production
 * keeps Pino's newline-delimited JSON for log collectors. Pino passes every level through, so the
 * Routa logger's level is the only filter.
 */
function createPino(): Logger {
	const options = { name: "full-api", level: "trace", timestamp: pino.stdTimeFunctions.isoTime };

	return process.env.NODE_ENV === "production"
		? pino(options)
		: pino(
				options,
				pretty({
					colorize: process.stdout.isTTY,
					ignore: "pid,hostname",
					translateTime: "SYS:standard",
				}),
			);
}

/**
 * The application's shared logger. `src/routa.ts` configures it for Routa, and any module can
 * import it directly; a service that logs for one request takes `ctx.logger` as an argument instead.
 */
export const logger = createLogger({
	level: (process.env.LOG_LEVEL ?? "info") as RoutaLogLevelWithSilent,
	sink: pinoSink(createPino()),
});
