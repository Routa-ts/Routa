import { markCreatedLogger } from "./logger-registry.js";

/** Routa's standard log levels, ordered from least to most severe. */
export type RoutaLogLevel = "trace" | "debug" | "info" | "warn" | "error" | "fatal";

export type RoutaLogLevelWithSilent = RoutaLogLevel | "silent";

export type RoutaLogData = Record<string, unknown>;

/**
 * One structured log event. A sink receives it sanitized: strings escaped and bounded, sensitive
 * fields redacted, and `data` holding only JSON values.
 */
export type RoutaLogEvent = {
	level: RoutaLogLevel;
	event: string;
	message: string;
	timestamp: string;
	data?: RoutaLogData;
};

/**
 * Receives each sanitized event a logger writes, such as to forward it to Pino or another backend.
 * Routa calls it synchronously and never awaits a returned promise. A throw or rejection loses
 * that event and is reported once; the application owns the backend's buffering, flushing, and
 * shutdown.
 */
export type RoutaLogSink = (event: RoutaLogEvent) => void;

/**
 * Marks loggers `createLogger` returned. It exists only in types: no value carries it, so an
 * object written by hand cannot satisfy {@link RoutaLogger}.
 */
declare const createdByCreateLogger: unique symbol;

/**
 * A logger `createLogger` returned. Every event any of its methods writes, including its children's,
 * is sanitized before its sink receives it. Routa accepts no other logger implementation; send
 * events to another backend from a sink.
 */
export type RoutaLogger = {
	readonly [createdByCreateLogger]: true;
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
	/**
	 * `false` makes every method a no-op that reads nothing it is given, as level `"silent"` does.
	 * Defaults to `true`.
	 */
	enabled?: boolean;
	/** The least severe level written. Defaults to `"info"`. */
	level?: RoutaLogLevelWithSilent;
	/** Defaults to one JSON line per event on the console. */
	sink?: RoutaLogSink;
	/**
	 * Field paths to redact in addition to the baseline sensitive names, which always apply.
	 * Segments are separated by `.` and matched case-insensitively from the root of the event data;
	 * `*` matches any key or array index, such as `"orders.*.card"`.
	 */
	redact?: readonly string[];
	/** The clock for event timestamps. Defaults to `() => new Date()`. */
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

/** What an event holds before sanitization, read from the caller without running its code. */
type RawEvent = {
	readonly level: RoutaLogLevel;
	readonly event: unknown;
	readonly message: unknown;
	readonly timestamp: unknown;
	readonly data: unknown;
};

/**
 * Creates a logger that sanitizes every event before its sink receives it. Level methods,
 * `log(event)`, and child bindings share one pipeline: baseline and `redact` fields become
 * `[Redacted]`, strings are escaped and bounded, and data is copied as JSON values without running
 * getters or `toJSON`. The caller's objects are never changed. Logging never throws: an event that
 * cannot be sanitized is discarded, and a failing sink loses only its event.
 *
 * @param options - Logger configuration.
 * @returns A logger that writes events through the configured sink.
 * @throws {TypeError} When an option is unknown or invalid
 */
export function createLogger(options: CreateLoggerOptions = {}): RoutaLogger {
	assertLoggerOptions(options);
	if (options.enabled === false || options.level === "silent") {
		return createDisabledLogger();
	}

	const minimumLevel = options.level ?? "info";
	const now = options.now ?? (() => new Date());
	const sink = options.sink ?? writeConsoleLog;
	const paths: PendingPaths = (options.redact ?? []).map((path) => path.toLowerCase().split("."));
	const report = createFallbackReporter();

	function isLevelEnabled(level: unknown): boolean {
		return (
			typeof level === "string"
			&& level !== "silent"
			&& Object.hasOwn(logLevelValues, level)
			&& logLevelValues[level as RoutaLogLevel] >= logLevelValues[minimumLevel]
		);
	}

	/**
	 * @param bindings - Sanitized bindings, which no caller can reach or change, or `undefined`
	 *   when they could not be sanitized and every event must be discarded.
	 */
	function buildLogger(bindings: RoutaLogData | undefined): RoutaLogger {
		/**
		 * The one path every event takes to the sink, whichever method produced it. Nothing it
		 * calls can throw to the caller, and it never waits for the sink.
		 *
		 * @param read - Reads the event, or returns `undefined` when its level is disabled
		 */
		function deliver(read: () => RawEvent | undefined): void {
			let event: RoutaLogEvent;

			try {
				const raw = read();

				if (!raw) {
					return;
				}

				if (!bindings) {
					throw new TypeError("The logger's bindings could not be sanitized.");
				}

				const fields = sanitizeMerged(bindings, raw.data ?? {}, paths);
				event = {
					timestamp: sanitizeText(raw.timestamp),
					level: raw.level,
					event: sanitizeText(raw.event),
					message: sanitizeText(raw.message),
					...(Object.keys(fields).length > 0 && { data: fields }),
				};
			} catch {
				report("event_discarded");
				return;
			}

			try {
				const delivery: unknown = sink(event);

				if (delivery !== undefined) {
					Promise.resolve(delivery).then(undefined, () => report("sink_failed"));
				}
			} catch {
				report("sink_failed");
			}
		}

		function emit(level: RoutaLogLevel, event: string, message: string, data?: RoutaLogData): void {
			if (isLevelEnabled(level)) {
				deliver(() => ({
					level,
					event,
					message,
					timestamp: Date.prototype.toISOString.call(now()),
					data,
				}));
			}
		}

		const logger: Omit<RoutaLogger, typeof createdByCreateLogger> = {
			log: (input) =>
				deliver(() => {
					const level = ownValue(input, "level");

					return isLevelEnabled(level)
						? {
								level: level as RoutaLogLevel,
								event: ownValue(input, "event"),
								message: ownValue(input, "message"),
								timestamp: ownValue(input, "timestamp"),
								data: ownValue(input, "data"),
							}
						: undefined;
				}),
			trace: (event, message, data) => emit("trace", event, message, data),
			debug: (event, message, data) => emit("debug", event, message, data),
			info: (event, message, data) => emit("info", event, message, data),
			warn: (event, message, data) => emit("warn", event, message, data),
			error: (event, message, data) => emit("error", event, message, data),
			fatal: (event, message, data) => emit("fatal", event, message, data),
			silent: () => undefined,
			child: (childBindings) => buildLogger(childOf(bindings, childBindings)),
			bindings: () => (bindings ? structuredClone(bindings) : {}),
			isLevelEnabled,
		};

		return markCreatedLogger(logger as RoutaLogger);
	}

	function childOf(bindings: RoutaLogData | undefined, added: unknown): RoutaLogData | undefined {
		if (!bindings) {
			return undefined;
		}

		try {
			return sanitizeMerged(bindings, added, paths);
		} catch {
			return undefined;
		}
	}

	return buildLogger({});
}

/**
 * The logger for `enabled: false` and level `"silent"`. Its methods return before reading what
 * they are given, so no getter or proxy trap runs and a child keeps no bindings.
 */
function createDisabledLogger(): RoutaLogger {
	const ignore = (): void => undefined;
	const methods: Omit<RoutaLogger, typeof createdByCreateLogger> = {
		log: ignore,
		trace: ignore,
		debug: ignore,
		info: ignore,
		warn: ignore,
		error: ignore,
		fatal: ignore,
		silent: ignore,
		child: () => logger,
		bindings: () => ({}),
		isLevelEnabled: () => false,
	};
	const logger = markCreatedLogger(methods as RoutaLogger);

	return logger;
}

const optionNames = ["enabled", "level", "sink", "redact", "now"] as const;

/**
 * @throws {TypeError} When an option is unknown or has the wrong shape, so a mistake surfaces when
 *   the logger is created instead of as missing or unredacted output
 */
function assertLoggerOptions(options: unknown): asserts options is CreateLoggerOptions {
	if (typeof options !== "object" || options === null || Array.isArray(options)) {
		throw new TypeError("createLogger options must be an object.");
	}

	for (const name of Object.keys(options)) {
		if (!(optionNames as readonly string[]).includes(name)) {
			throw new TypeError(
				`createLogger does not accept ${JSON.stringify(name)}. It accepts enabled, level, sink, redact, and now; send events to another backend from a sink.`,
			);
		}
	}

	const { enabled, level, sink, redact, now } = options as Record<string, unknown>;

	if (enabled !== undefined && typeof enabled !== "boolean") {
		throw new TypeError("createLogger enabled must be a boolean.");
	}

	if (level !== undefined && !(typeof level === "string" && Object.hasOwn(logLevelValues, level))) {
		throw new TypeError(
			`createLogger level must be one of ${Object.keys(logLevelValues)
				.map((name) => JSON.stringify(name))
				.join(", ")}.`,
		);
	}

	if (sink !== undefined && typeof sink !== "function") {
		throw new TypeError("createLogger sink must be a function that receives each sanitized event.");
	}

	if (now !== undefined && typeof now !== "function") {
		throw new TypeError("createLogger now must be a function that returns a Date.");
	}

	if (
		redact !== undefined
		&& !(Array.isArray(redact) && redact.every((path) => typeof path === "string"))
	) {
		throw new TypeError(
			'createLogger redact must be an array of field paths, such as ["user.email"].',
		);
	}

	for (const path of (redact as readonly string[] | undefined) ?? []) {
		if (path.split(".").includes("")) {
			throw new TypeError(
				`createLogger redact path ${JSON.stringify(path)} has an empty segment. Separate field names with single dots, such as "user.email".`,
			);
		}
	}
}

type FallbackKind = "event_discarded" | "sink_failed";

const fallbackMessages: Readonly<Record<FallbackKind, string>> = {
	event_discarded:
		"A Routa logger discarded an event it could not sanitize. Later discarded events from this logger are not reported.",
	sink_failed:
		"A Routa logger sink threw or rejected. Later sink failures from this logger are not reported.",
};

/**
 * Reports each kind of logger failure once per `createLogger` call, as a fixed line on
 * `console.error`. It never calls the failed logger or its sink, and never includes the failed
 * event or error, so a failure cannot recurse or leak what the sink was meant to receive.
 */
function createFallbackReporter(): (kind: FallbackKind) => void {
	const reported = new Set<FallbackKind>();

	return (kind) => {
		if (reported.has(kind)) {
			return;
		}

		reported.add(kind);

		try {
			globalThis.console.error(
				JSON.stringify({
					level: "error",
					event: `routa.logger.${kind}`,
					message: fallbackMessages[kind],
					timestamp: new Date().toISOString(),
				}),
			);
		} catch {
			// Nowhere is left to report to.
		}
	};
}

const redactedMarker = "[Redacted]";
const circularMarker = "[Circular]";
const truncatedMarker = "[Truncated]";
const unsupportedMarker = "[Unsupported]";

/** Objects and arrays nested deeper than this below the event data read as truncated. */
const maxDepth = 10;
/** Each object keeps this many keys and each array this many items, then one truncation marker. */
const maxEntries = 100;
/**
 * Values sanitized for one event's data, its bindings included, or for one child's bindings;
 * later values read as truncated.
 */
const maxValues = 1000;
/** Escaped strings longer than this are cut so that, with the marker, they have this length. */
const maxStringLength = 4096;

/**
 * Field names redacted at any depth in every logger. A key matches when, lowercased with `-` and
 * `_` removed, it equals one of these, so `Set-Cookie`, `x-api-key`, and `API_KEY` match while
 * `tokenCount` does not.
 */
const sensitiveNames: ReadonlySet<string> = new Set([
	"accesstoken",
	"apikey",
	"authorization",
	"authtoken",
	"clientsecret",
	"cookie",
	"csrftoken",
	"idtoken",
	"passphrase",
	"password",
	"privatekey",
	"proxyauthorization",
	"refreshtoken",
	"secret",
	"sessionid",
	"sessiontoken",
	"setcookie",
	"token",
	"xapikey",
	"xauthtoken",
	"xcsrftoken",
]);

function isSensitiveName(key: string): boolean {
	return sensitiveNames.has(key.toLowerCase().replaceAll(/[-_]/g, ""));
}

/**
 * Characters that can forge or hide log lines in terminals and line-based collectors: C0 and C1
 * controls, DEL, line and paragraph separators, and bidirectional formatting controls.
 */
const unsafeCharacters =
	// oxlint-disable-next-line no-control-regex -- matching control characters is the point.
	/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
const namedEscapes: Readonly<Record<string, string>> = { "\n": "\\n", "\r": "\\r", "\t": "\\t" };

/** A string field of the event, escaped; any other value reads as unsupported. */
function sanitizeText(value: unknown): string {
	return typeof value === "string" ? safeText(value) : unsupportedMarker;
}

/**
 * Escapes characters that could forge or hide log lines, so every emitted string is one line, then
 * bounds its length. Escaping only lengthens text, so it runs on at most the first
 * `maxStringLength` characters, whatever the input's length.
 */
function safeText(value: string): string {
	const escaped = value
		.slice(0, maxStringLength)
		.replace(
			unsafeCharacters,
			(character) =>
				namedEscapes[character] ?? `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
		);

	if (value.length <= maxStringLength && escaped.length <= maxStringLength) {
		return escaped;
	}

	let end = maxStringLength - truncatedMarker.length;
	// Never split a surrogate pair.
	if (/[\ud800-\udbff]/.test(escaped.charAt(end - 1))) {
		end -= 1;
	}

	return `${escaped.slice(0, end)}${truncatedMarker}`;
}

/**
 * One sanitization pass: the containers on the path from the event data to the current value,
 * and the values it may still visit.
 */
type Traversal = { readonly ancestors: Set<object>; remaining: number };

/**
 * The rest of each custom redaction path that can still match below a value, as lowercase
 * segments; `*` matches any key or array index.
 */
type PendingPaths = readonly (readonly string[])[];

/**
 * The custom paths that continue below a key, or `"redact"` when one ends at it.
 *
 * @param key - An object key or array index
 */
function followPaths(pending: PendingPaths, key: string): PendingPaths | "redact" {
	if (pending.length === 0) {
		return pending;
	}

	const name = key.toLowerCase();
	const next: (readonly string[])[] = [];

	for (const [segment, ...rest] of pending) {
		if (segment === "*" || segment === name) {
			if (rest.length === 0) {
				return "redact";
			}

			next.push(rest);
		}
	}

	return next;
}

/**
 * Sanitizes one value into JSON-compatible data. Plain objects, arrays, and dates are copied;
 * every other object reads as unsupported, so no getter, `toJSON`, or other method runs.
 */
function sanitizeValue(value: unknown, traversal: Traversal, pending: PendingPaths): unknown {
	if (traversal.remaining <= 0) {
		return truncatedMarker;
	}

	traversal.remaining -= 1;

	if (value === null) {
		return null;
	}

	switch (typeof value) {
		case "string":
			return safeText(value);
		case "boolean":
			return value;
		case "number":
			return Number.isFinite(value) ? value : null;
		case "bigint":
			return safeText(value.toString());
		case "undefined":
			return undefined;
		case "object":
			return sanitizeObject(value, traversal, pending);
		default:
			return unsupportedMarker;
	}
}

function sanitizeObject(value: object, traversal: Traversal, pending: PendingPaths): unknown {
	const time = dateValue(value);

	if (time !== undefined) {
		return Number.isNaN(time) ? null : Date.prototype.toISOString.call(value);
	}

	if (traversal.ancestors.has(value)) {
		return circularMarker;
	}

	if (traversal.ancestors.size > maxDepth) {
		return truncatedMarker;
	}

	const isArray = Array.isArray(value);

	if (isArray ? Object.getPrototypeOf(value) !== Array.prototype : !isPlainObject(value)) {
		return unsupportedMarker;
	}

	traversal.ancestors.add(value);

	try {
		return isArray
			? sanitizeItems(value, traversal, pending)
			: sanitizeEntries(value, traversal, pending);
	} finally {
		traversal.ancestors.delete(value);
	}
}

function isPlainObject(value: unknown): value is object {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}

	const prototype = Object.getPrototypeOf(value);
	return prototype === Object.prototype || prototype === null;
}

/** A date's time value, read through the intrinsic so no method of the value runs. */
function dateValue(value: object): number | undefined {
	try {
		return Date.prototype.getTime.call(value);
	} catch {
		return undefined;
	}
}

/**
 * Reads an own property without running code: an accessor's getter never runs, so it reads as
 * unsupported.
 */
function ownValue(value: unknown, key: string): unknown {
	// Throws for `null` and `undefined`, which the caller's containment turns into a discarded event.
	const descriptor = Object.getOwnPropertyDescriptor(value as object, key);

	if (!descriptor) {
		return undefined;
	}

	return "value" in descriptor ? descriptor.value : unsupportedMarker;
}

function sanitizeItems(
	value: readonly unknown[],
	traversal: Traversal,
	pending: PendingPaths,
): unknown[] {
	const length = ownValue(value, "length") as number;
	const items: unknown[] = [];

	for (let index = 0; index < length; index += 1) {
		if (index === maxEntries) {
			items.push(truncatedMarker);
			break;
		}

		const key = String(index);
		const next = followPaths(pending, key);
		items.push(
			next === "redact"
				? redactedMarker
				: (sanitizeValue(ownValue(value, key), traversal, next) ?? null),
		);
	}

	return items;
}

function sanitizeEntries(
	value: object,
	traversal: Traversal,
	pending: PendingPaths,
): Record<string, unknown> {
	const entries: Array<[string, unknown]> = [];
	const keys = Object.keys(value);

	for (const key of keys.slice(0, maxEntries)) {
		const next = isSensitiveName(key) ? "redact" : followPaths(pending, key);
		const item =
			next === "redact" ? redactedMarker : sanitizeValue(ownValue(value, key), traversal, next);

		if (item !== undefined) {
			entries.push([safeText(key), item]);
		}
	}

	if (keys.length > maxEntries) {
		entries.push([truncatedMarker, truncatedMarker]);
	}

	return Object.fromEntries(entries);
}

/**
 * Sanitizes `added` merged over `base` as one object, so every limit holds for the result as a
 * whole: an event's data with its bindings, or a child's bindings with its parent's. `base` keys
 * come first, and an `added` key replaces a `base` key of the same name in place.
 *
 * @param base - Bindings that were already sanitized, so copying them runs no caller code
 * @throws {TypeError} When `added` is not a plain object
 */
function sanitizeMerged(base: RoutaLogData, added: unknown, paths: PendingPaths): RoutaLogData {
	if (!isPlainObject(added)) {
		throw new TypeError("Log data must be a plain object.");
	}

	const merged: Record<string, unknown> = { ...base };

	// Copying descriptors, not values, keeps an accessor unread so it still reads as unsupported.
	// One key past the limit is enough to mark the merged object as truncated.
	for (const key of Object.keys(added).slice(0, maxEntries + 1)) {
		const descriptor = Object.getOwnPropertyDescriptor(added, key);

		if (descriptor) {
			Object.defineProperty(merged, key, { ...descriptor, configurable: true, enumerable: true });
		}
	}

	// No caller can reach `merged`, so `added` stands in for it as the root: a reference back to
	// the data still reads as circular, and depth counts from the data.
	return sanitizeEntries(merged, { ancestors: new Set([added]), remaining: maxValues }, paths);
}

/**
 * The default sink: writes each sanitized event as one JSON line, to `console.error` for `error`
 * and `fatal`, `console.warn` for `warn`, and `console.log` otherwise.
 */
function writeConsoleLog(event: RoutaLogEvent): void {
	const line = JSON.stringify(event);

	if (event.level === "error" || event.level === "fatal") {
		globalThis.console.error(line);
		return;
	}

	if (event.level === "warn") {
		globalThis.console.warn(line);
		return;
	}

	globalThis.console.log(line);
}
