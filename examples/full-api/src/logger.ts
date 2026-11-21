import {
	createLogger,
	type RoutaLogger,
	type RoutaLogLevelWithSilent,
	type RoutaLogSink,
} from "@routa-ts/core";
import pino, { type DestinationStream, type Logger } from "pino";
import pretty from "pino-pretty";

/**
 * Forwards each event to Pino at the same level. Routa has already redacted, escaped, and bounded
 * the event, so the sink only chooses the output. The data stays under its own key: Pino reads
 * `level`, `time`, `msg`, and its other top-level fields as its own, so spreading the data there
 * would let a `level` field change the line's level.
 */
function pinoSink(output: Logger): RoutaLogSink {
	return ({ level, event, message, data }) => output[level]({ event, data }, message);
}

/** The environment variables the example's logger reads. */
export type LoggerEnvironment = { readonly LOG_LEVEL?: string; readonly NODE_ENV?: string };

/**
 * The application's Pino instance, which the application owns: its destination, buffering,
 * flushing, and shutdown. Development uses pino-pretty for readable terminal output; production
 * keeps Pino's newline-delimited JSON for log collectors. Pino passes every level through, so the
 * Routa logger's level is the only filter.
 *
 * @param destination - Where Pino writes instead, such as a capture in a test
 */
function createPino(environment: LoggerEnvironment, destination?: DestinationStream): Logger {
	const options = { name: "full-api", level: "trace", timestamp: pino.stdTimeFunctions.isoTime };

	if (destination) {
		return pino(options, destination);
	}

	return environment.NODE_ENV === "production"
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
 * Creates the example's logger: Routa's level from `LOG_LEVEL`, `info` by default, with every
 * event forwarded to Pino.
 *
 * @param destination - Where Pino writes; defaults to the terminal
 */
export function createAppLogger(
	environment: LoggerEnvironment,
	destination?: DestinationStream,
): RoutaLogger {
	return createLogger({
		level: (environment.LOG_LEVEL ?? "info") as RoutaLogLevelWithSilent,
		sink: pinoSink(createPino(environment, destination)),
	});
}

/**
 * The application's shared logger. `src/routa.ts` configures it for Routa, and any module can
 * import it directly; a service that logs for one request takes `ctx.logger` as an argument instead.
 */
export const logger = createAppLogger(process.env);
