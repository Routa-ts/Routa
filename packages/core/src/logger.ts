/** Routa's standard log levels, ordered from least to most severe. */
export type RoutaLogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export type RoutaLogLevelWithSilent = RoutaLogLevel | "silent";

export type RoutaLogData = Record<string, unknown>;

export type RoutaLogEvent = {
	level: RoutaLogLevel;
	event: string;
	message: string;
	timestamp: string;
	data?: RoutaLogData;
};

export type RoutaLogger = {
	log: (event: RoutaLogEvent) => void;
	trace: (event: string, message: string, data?: RoutaLogData) => void;
	debug: (event: string, message: string, data?: RoutaLogData) => void;
	info: (event: string, message: string, data?: RoutaLogData) => void;
	warn: (event: string, message: string, data?: RoutaLogData) => void;
	error: (event: string, message: string, data?: RoutaLogData) => void;
	fatal: (event: string, message: string, data?: RoutaLogData) => void;
	silent: (event: string, message: string, data?: RoutaLogData) => void;
	child: (bindings: RoutaLogData) => RoutaLogger;
	bindings: () => RoutaLogData;
	isLevelEnabled: (level: RoutaLogLevelWithSilent) => boolean;
};

export type CreateLoggerOptions = {
	enabled?: boolean;
	level?: RoutaLogLevelWithSilent;
	sink?: (event: RoutaLogEvent) => void;
	now?: () => Date;
};

const logLevelValues: Record<RoutaLogLevelWithSilent, number> = {
	trace: 10,
	debug: 20,
	info: 30,
	warn: 40,
	error: 50,
	fatal: 60,
	silent: Number.POSITIVE_INFINITY,
};

/**
 * Creates a logger with optional custom output, time source, and enablement.
 *
 * @param options - Logger configuration.
 * @returns A logger that writes events through the configured sink.
 */
export function createLogger(options: CreateLoggerOptions = {}): RoutaLogger {
	const enabled = options.enabled ?? true;
	const minimumLevel = enabled ? (options.level ?? "info") : "silent";
	const now = options.now ?? (() => new Date());
	const sink = options.sink ?? writeConsoleLog;

	function buildLogger(bindings: RoutaLogData): RoutaLogger {
		function isLevelEnabled(level: RoutaLogLevelWithSilent): boolean {
			return level !== "silent" && logLevelValues[level] >= logLevelValues[minimumLevel];
		}

		function write(event: RoutaLogEvent): void {
			if (!isLevelEnabled(event.level)) {
				return;
			}

			const data = { ...bindings, ...event.data };
			sink({
				...event,
				...(Object.keys(data).length > 0 ? { data } : {}),
			});
		}

		function emit(level: RoutaLogLevel, event: string, message: string, data?: RoutaLogData): void {
			write({
				level,
				event,
				message,
				timestamp: now().toISOString(),
				...(data ? { data } : {}),
			});
		}

		return {
			log: write,
			trace: (event, message, data) => emit("trace", event, message, data),
			debug: (event, message, data) => emit("debug", event, message, data),
			info: (event, message, data) => emit("info", event, message, data),
			warn: (event, message, data) => emit("warn", event, message, data),
			error: (event, message, data) => emit("error", event, message, data),
			fatal: (event, message, data) => emit("fatal", event, message, data),
			silent: () => undefined,
			child: (childBindings) => buildLogger({ ...bindings, ...childBindings }),
			bindings: () => ({ ...bindings }),
			isLevelEnabled,
		};
	}

	return buildLogger({});
}

/**
 * Writes a log event to the console.
 *
 * @param event - The log event to write
 */
function writeConsoleLog(event: RoutaLogEvent): void {
	const payload = event.data ? ` ${stringifyLogData(event.data)}` : "";
	const line = `[${event.timestamp}] ${event.level.toUpperCase()} ${event.event} ${event.message}${payload}`;

	if (event.level === "error" || event.level === "fatal") {
		// biome-ignore lint/suspicious/noConsole: The default logger intentionally writes runtime logs.
		globalThis.console.error(line);
		return;
	}

	if (event.level === "warn") {
		// biome-ignore lint/suspicious/noConsole: The default logger intentionally writes runtime logs.
		globalThis.console.warn(line);
		return;
	}

	// biome-ignore lint/suspicious/noConsole: The default logger intentionally writes runtime logs.
	globalThis.console.log(line);
}

function stringifyLogData(data: RoutaLogData): string {
	try {
		return JSON.stringify(data);
	} catch {
		return "[unserializable]";
	}
}
