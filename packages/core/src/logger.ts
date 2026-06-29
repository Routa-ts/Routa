export type RoutaLogLevel = "info" | "warn" | "error";

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
	info: (event: string, message: string, data?: RoutaLogData) => void;
	warn: (event: string, message: string, data?: RoutaLogData) => void;
	error: (event: string, message: string, data?: RoutaLogData) => void;
};

export type CreateLoggerOptions = {
	enabled?: boolean;
	sink?: (event: RoutaLogEvent) => void;
	now?: () => Date;
};

/**
 * Creates a logger with optional custom output, time source, and enablement.
 *
 * @param options - Logger configuration.
 * @returns A logger that writes events through the configured sink.
 */
export function createLogger(options: CreateLoggerOptions = {}): RoutaLogger {
	const enabled = options.enabled ?? true;
	const now = options.now ?? (() => new Date());
	const sink = options.sink ?? writeConsoleLog;

	function emit(level: RoutaLogLevel, event: string, message: string, data?: RoutaLogData): void {
		if (!enabled) {
			return;
		}

		sink({
			level,
			event,
			message,
			timestamp: now().toISOString(),
			...(data ? { data } : {}),
		});
	}

	return {
		log: (event) => {
			if (enabled) {
				sink(event);
			}
		},
		info: (event, message, data) => emit("info", event, message, data),
		warn: (event, message, data) => emit("warn", event, message, data),
		error: (event, message, data) => emit("error", event, message, data),
	};
}

/**
 * Writes a log event to the console.
 *
 * @param event - The log event to write
 */
function writeConsoleLog(event: RoutaLogEvent): void {
	const payload = event.data ? ` ${stringifyLogData(event.data)}` : "";
	const line = `[${event.timestamp}] ${event.level.toUpperCase()} ${event.event} ${event.message}${payload}`;

	if (event.level === "error") {
		// biome-ignore lint/suspicious/noConsole: The default logger intentionally writes runtime logs.
		globalThis.console.error(line);
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
