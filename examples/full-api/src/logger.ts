import type { RoutaLogData, RoutaLogEvent, RoutaLogger, RoutaLogLevel } from "@routa-ts/core";
import pino, { type Logger, type LoggerOptions } from "pino";
import pretty from "pino-pretty";

/**
 * Adapts Pino to Routa's backend-agnostic structured logger interface.
 *
 * Development uses pino-pretty for readable terminal output. Production keeps
 * Pino's newline-delimited JSON output for log collectors.
 */
export function createFullApiLogger(): RoutaLogger {
	const options: LoggerOptions = {
		name: "full-api",
		level: process.env.LOG_LEVEL ?? "info",
		timestamp: pino.stdTimeFunctions.isoTime,
	};
	const destination =
		process.env.NODE_ENV === "production"
			? undefined
			: pretty({
					colorize: process.stdout.isTTY,
					ignore: "pid,hostname",
					translateTime: "SYS:standard",
				});
	const output = destination ? pino(options, destination) : pino(options);

	return adaptPino(output);
}

function adaptPino(output: Logger): RoutaLogger {
	function emit(level: RoutaLogLevel, event: string, message: string, data?: RoutaLogData): void {
		output[level]({ ...data, event }, message);
	}

	return {
		log: ({ data, event, level, message }: RoutaLogEvent) => emit(level, event, message, data),
		trace: (event, message, data) => emit("trace", event, message, data),
		debug: (event, message, data) => emit("debug", event, message, data),
		info: (event, message, data) => emit("info", event, message, data),
		warn: (event, message, data) => emit("warn", event, message, data),
		error: (event, message, data) => emit("error", event, message, data),
		fatal: (event, message, data) => emit("fatal", event, message, data),
		silent: (event, message, data) => output.silent({ ...data, event }, message),
		child: (bindings) => adaptPino(output.child(bindings)),
		bindings: () => output.bindings(),
		isLevelEnabled: (level) => output.isLevelEnabled(level),
	};
}
