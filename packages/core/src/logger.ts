import { observeRejection, writeFallbackLine } from "./fallback.js";
import {
	type FrameworkEvent,
	markCreatedLogger,
	type RequestIdentityFields,
	type RequestLogging,
} from "./logger-registry.js";

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
 * shutdown. A returned promise subclass whose `constructor`, `Symbol.species`, or species
 * constructor throws cannot be observed, so its rejection can remain unhandled; handle such
 * rejections in the backend.
 */
export type RoutaLogSink = (event: RoutaLogEvent) => void;

/**
 * Marks loggers `createLogger` returned. It exists only in types: no value carries it, so an
 * object written by hand cannot satisfy {@link RoutaLogger}.
 */
declare const useCreateLoggerWithASink: unique symbol;

/**
 * A logger `createLogger` returned. Every event any of its methods writes, including its children's,
 * is sanitized before its sink receives it. Routa accepts no other logger implementation; send
 * events to another backend from a sink. The logger is frozen, so its methods cannot be replaced.
 */
export type RoutaLogger = {
	readonly [useCreateLoggerWithASink]: true;
	readonly log: (event: RoutaLogEvent) => void;
	readonly trace: (event: string, message: string, data?: RoutaLogData) => void;
	readonly debug: (event: string, message: string, data?: RoutaLogData) => void;
	readonly info: (event: string, message: string, data?: RoutaLogData) => void;
	readonly warn: (event: string, message: string, data?: RoutaLogData) => void;
	readonly error: (event: string, message: string, data?: RoutaLogData) => void;
	readonly fatal: (event: string, message: string, data?: RoutaLogData) => void;
	readonly silent: (event: string, message: string, data?: RoutaLogData) => void;
	readonly child: (bindings: RoutaLogData) => RoutaLogger;
	readonly bindings: () => RoutaLogData;
	readonly isLevelEnabled: (level: RoutaLogLevelWithSilent) => boolean;
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
	 * `*` matches any key or array index, such as `"orders.*.card"`. No path redacts the
	 * `requestId` and `correlationId` a request logger binds at the root, so request events log
	 * the identity the response headers carry.
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
	/** Fields written first, which neither bindings nor data replace or crowd out. */
	readonly kept?: RoutaLogData | undefined;
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
export function createLogger(input: CreateLoggerOptions = {}): RoutaLogger {
	const options = snapshotLoggerOptions(input);
	if (options.enabled === false || options.level === "silent") {
		return createDisabledLogger();
	}

	const minimumLevel = options.level ?? "info";
	const now = options.now ?? (() => new Date());
	const sink = options.sink ?? writeConsoleLog;
	const paths: PendingPaths = (options.redact ?? []).map((path) =>
		path.split(".").map(normalizeName),
	);
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
	 * @param identity - The request identity fields among the bindings, which every event and
	 *   child writes first and keeps whatever data or bindings it adds
	 * @returns The logger, and the writer for Routa's own events through it
	 */
	function buildLogger(
		bindings: RoutaLogData | undefined,
		identity: RoutaLogData,
	): RequestLogging<RoutaLogger> {
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

				const fields = sanitizeMerged(
					bindings,
					raw.data ?? {},
					paths,
					false,
					raw.kept ?? identity,
					identity,
				);
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
					observeRejection(delivery, () => report("sink_failed"));
				}
			} catch {
				report("sink_failed");
			}
		}

		/** @param kept - Fields written first, after the identity, which no binding crowds out */
		function emit(
			level: RoutaLogLevel,
			event: string,
			message: string,
			data?: RoutaLogData,
			kept?: RoutaLogData,
		): void {
			if (isLevelEnabled(level)) {
				deliver(() => ({
					level,
					event,
					message,
					timestamp: Date.prototype.toISOString.call(now()),
					data,
					kept,
				}));
			}
		}

		const logger: Omit<RoutaLogger, typeof useCreateLoggerWithASink> = {
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
			child: (childBindings) =>
				buildLogger(childOf(bindings, childBindings, identity), identity).logger,
			bindings: () => (bindings ? structuredClone(bindings) : {}),
			isLevelEnabled,
		};
		// Routa's own events write their fields right after the identity, which still wins.
		const frameworkEvent: FrameworkEvent = (level, event, message, data) =>
			emit(level, event, message, {}, { ...identity, ...data, ...identity });

		return {
			logger: markCreatedLogger(logger as RoutaLogger, (fields) =>
				requestLogger(bindings, identity, fields),
			),
			event: frameworkEvent,
		};
	}

	/**
	 * A child bound to request identity fields, which come first in its bindings and every event.
	 * A field without a value, such as `correlationId` when none was accepted, appears in neither,
	 * whatever the bindings or event data hold. The fields replace any identity this logger
	 * already binds, so a request logger configured as another app's logger logs each request
	 * that app handles with that request's identity, not its own.
	 */
	function requestLogger(
		bindings: RoutaLogData | undefined,
		identity: RoutaLogData,
		fields: RequestIdentityFields,
	): RequestLogging<RoutaLogger> {
		const kept = { ...identity, ...fields };
		return buildLogger(childOf(bindings, {}, kept), kept);
	}

	/** @param kept - The identity fields, which the child's bindings hold first and keep */
	function childOf(
		bindings: RoutaLogData | undefined,
		added: unknown,
		kept: RoutaLogData,
	): RoutaLogData | undefined {
		if (!bindings) {
			return undefined;
		}

		try {
			return sanitizeMerged(bindings, added, paths, true, kept, kept);
		} catch {
			return undefined;
		}
	}

	return buildLogger({}, {}).logger;
}

/**
 * The logger for `enabled: false` and level `"silent"`. Its methods return before reading what
 * they are given, so no getter or proxy trap runs and a child keeps no bindings.
 */
function createDisabledLogger(): RoutaLogger {
	const ignore = (): void => undefined;
	const methods: Omit<RoutaLogger, typeof useCreateLoggerWithASink> = {
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
	const logger: RoutaLogger = markCreatedLogger(methods as RoutaLogger, () => ({
		logger,
		event: ignore,
	}));

	return logger;
}

const optionNames = ["enabled", "level", "sink", "redact", "now"] as const;

/**
 * @throws {TypeError} When an option is unknown or has the wrong shape, so a mistake surfaces when
 *   the logger is created instead of as missing or unredacted output
 */
/**
 * Reads each option once, then validates that copy, so a getter cannot pass validation with one
 * value and configure the logger with another.
 */
function snapshotLoggerOptions(input: unknown): CreateLoggerOptions {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		throw new TypeError("createLogger options must be an object.");
	}

	// Unknown names are rejected as written, and each known option is read once, as plain property
	// access reads it, into an object with no prototype, so a `__proto__` key cannot reach it.
	assertKnownOptionNames(input);
	const snapshot = Object.create(null) as Record<string, unknown>;
	for (const name of optionNames) {
		const value: unknown = (input as Record<string, unknown>)[name];
		if (value !== undefined) {
			snapshot[name] = Array.isArray(value) ? [...(value as unknown[])] : value;
		}
	}

	assertLoggerOptions(snapshot);
	return snapshot;
}

function assertKnownOptionNames(options: object): void {
	for (const name of Object.getOwnPropertyNames(options)) {
		if (!(optionNames as readonly string[]).includes(name)) {
			throw new TypeError(
				`createLogger does not accept ${JSON.stringify(name)}. It accepts enabled, level, sink, redact, and now; send events to another backend from a sink.`,
			);
		}
	}
}

function assertLoggerOptions(options: unknown): asserts options is CreateLoggerOptions {
	if (typeof options !== "object" || options === null || Array.isArray(options)) {
		throw new TypeError("createLogger options must be an object.");
	}

	assertKnownOptionNames(options);

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
		writeFallbackLine(`routa.logger.${kind}`, fallbackMessages[kind]);
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
 * A bigint's decimal string fits `maxStringLength` exactly when the bigint lies strictly between
 * these, so comparing finds an oversized one without the conversion, which can take seconds.
 */
const bigintAbove = -(10n ** BigInt(maxStringLength - 1));
const bigintBelow = 10n ** BigInt(maxStringLength);

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
	"cookies",
	"credentials",
	"csrftoken",
	"currentpassword",
	"cvv",
	"idtoken",
	"jwt",
	"newpassword",
	"passphrase",
	"passwd",
	"password",
	"passwordhash",
	"privatekey",
	"proxyauthorization",
	"pwd",
	"refreshtoken",
	"secret",
	"secretaccesskey",
	"secretkey",
	"sessionid",
	"sessiontoken",
	"setcookie",
	"token",
	"xapikey",
	"xauthtoken",
	"xcsrftoken",
]);

/**
 * Whether the value under an object key is redacted, or the custom paths that continue below it.
 * It decides on the whole key, before escaping or truncation can change it. A key longer than
 * `maxStringLength` is always redacted: deciding exactly would cost time in proportion to its
 * length, and a padded sensitive name such as `password` followed by thousands of `-` must
 * still match.
 */
function redactionOf(key: string, pending: PendingPaths): PendingPaths | "redact" {
	if (key.length > maxStringLength) {
		return "redact";
	}

	const name = normalizeName(key);

	return sensitiveNames.has(name.replaceAll(/[-_]/g, "")) ? "redact" : followPaths(pending, name);
}

/**
 * The form in which keys and custom path segments are compared: escaped in full, as the sink
 * receives them before any truncation, then lowercased. A path written with a control character
 * and one written with its escape both match the key the sink sees.
 */
function normalizeName(name: string): string {
	return escapeText(name).toLowerCase();
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

/** Escapes characters that could forge or hide log lines, so the text is one line. */
function escapeText(value: string): string {
	return value.replace(
		unsafeCharacters,
		(character) =>
			namedEscapes[character] ?? `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
}

/**
 * Escapes text, so every emitted string is one line, then bounds its length. Escaping only
 * lengthens text, so it runs on at most the first `maxStringLength` characters, whatever the
 * input's length.
 */
function safeText(value: string): string {
	const escaped = escapeText(value.slice(0, maxStringLength));

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
 * The rest of each custom redaction path that can still match below a value, as segments in the
 * form {@link normalizeName} gives keys; `*` matches any key or array index.
 */
type PendingPaths = readonly (readonly string[])[];

/**
 * The custom paths that continue below a key, or `"redact"` when one ends at it.
 *
 * @param name - An object key as {@link normalizeName} gives it, or an array index
 */
function followPaths(pending: PendingPaths, name: string): PendingPaths | "redact" {
	if (pending.length === 0) {
		return pending;
	}

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
 * Sanitizes the value under one key or index. Every value it emits, `[Redacted]` and other
 * markers included, spends one of the traversal's remaining values; once none are left, it
 * emits `[Truncated]`.
 *
 * @param read - Reads the value; never called for a redacted one
 */
function sanitizeMember(
	read: () => unknown,
	traversal: Traversal,
	next: PendingPaths | "redact",
): unknown {
	if (traversal.remaining <= 0) {
		return truncatedMarker;
	}

	traversal.remaining -= 1;

	return next === "redact" ? redactedMarker : sanitizeValue(read(), traversal, next);
}

/**
 * Sanitizes one value into JSON-compatible data. Plain objects, arrays, and dates are copied;
 * every other object reads as unsupported, so no getter, `toJSON`, or other method runs.
 */
function sanitizeValue(value: unknown, traversal: Traversal, pending: PendingPaths): unknown {
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
			// Never cut: a shortened number reads as a different one.
			return value > bigintAbove && value < bigintBelow ? value.toString() : truncatedMarker;
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

	if (isArray ? !isPlainArray(value) : !isPlainObject(value)) {
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

	const prototype: unknown = Object.getPrototypeOf(value);
	// `Object.prototype` of any realm, such as an object from `node:vm` or another frame, is the
	// only non-array prototype whose own prototype is `null`.
	return (
		prototype === null || (!Array.isArray(prototype) && Object.getPrototypeOf(prototype) === null)
	);
}

/**
 * An array whose prototype is `Array.prototype` of any realm, which is itself an array whose
 * prototype is that realm's `Object.prototype`. A subclass's prototype is not an array.
 */
function isPlainArray(value: readonly unknown[]): boolean {
	const prototype: unknown = Object.getPrototypeOf(value);
	return (
		Array.isArray(prototype) && Object.getPrototypeOf(Object.getPrototypeOf(prototype)) === null
	);
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

/**
 * Reads an object's or array's member like {@link ownValue}, except that a missing or
 * non-enumerable one reads as `undefined`: dropped from an object, a hole in an array.
 */
function memberValue(value: object, key: string): unknown {
	const descriptor = Object.getOwnPropertyDescriptor(value, key);

	if (!descriptor?.enumerable) {
		return undefined;
	}

	return "value" in descriptor ? descriptor.value : unsupportedMarker;
}

/**
 * Copies an array's items. A proxy can report any `length`, so one that is not a whole number
 * reads the array as unsupported before anything compares with it and runs its code.
 */
function sanitizeItems(
	value: readonly unknown[],
	traversal: Traversal,
	pending: PendingPaths,
): unknown {
	const length = ownValue(value, "length");

	if (typeof length !== "number" || !Number.isInteger(length) || length < 0) {
		return unsupportedMarker;
	}

	const items: unknown[] = [];

	for (let index = 0; index < length; index += 1) {
		if (index === maxEntries) {
			items.push(truncatedMarker);
			spendMarker(traversal);
			break;
		}

		const key = String(index);
		items.push(
			sanitizeMember(() => memberValue(value, key), traversal, followPaths(pending, key)) ?? null,
		);
	}

	return items;
}

/**
 * An object member to sanitize: the key its redaction is decided on, how to read its value, and
 * whether it is request identity Routa binds, which no `redact` path names.
 */
type Member = { readonly key: string; readonly read: () => unknown; readonly identity?: true };

/** What a member that is never redacted continues with: no path. */
const noPaths: PendingPaths = [];

function sanitizeEntries(
	value: object,
	traversal: Traversal,
	pending: PendingPaths,
): Record<string, unknown> {
	const keys = Object.keys(value);
	const members = new Map<string, Member>();

	for (const key of keys.slice(0, maxEntries)) {
		members.set(safeText(key), { key, read: () => memberValue(value, key) });
	}

	return sanitizeMembers(members, keys.length > maxEntries, traversal, pending);
}

/**
 * Sanitizes the first `maxEntries` members, each under the escaped name the sink receives.
 *
 * @param members - Members by escaped name; a later member replaces an earlier one with the same
 *   name in place
 * @param truncated - Whether members were left out before these, which adds the truncation marker
 */
function sanitizeMembers(
	members: ReadonlyMap<string, Member>,
	truncated: boolean,
	traversal: Traversal,
	pending: PendingPaths,
): Record<string, unknown> {
	const entries: Array<[string, unknown]> = [];
	let visited = 0;

	for (const [name, { key, read, identity }] of members) {
		if (visited === maxEntries) {
			truncated = true;
			break;
		}

		visited += 1;
		const item = sanitizeMember(read, traversal, identity ? noPaths : redactionOf(key, pending));

		if (item !== undefined) {
			entries.push([name, item]);
		}
	}

	if (truncated) {
		entries.push([truncatedMarker, truncatedMarker]);
		spendMarker(traversal);
	}

	return Object.fromEntries(entries);
}

/** A container's own truncation marker spends one value too, as every other emitted value does. */
function spendMarker(traversal: Traversal): void {
	traversal.remaining = Math.max(0, traversal.remaining - 1);
}

/**
 * The key a child's sanitized binding name came from, kept only where escaping changed it and the
 * key fits the string limit, so a logger holds no more than its emitted bindings. A late event key
 * replaces a binding when it equals that original key.
 */
const bindingKeys = new WeakMap<RoutaLogData, ReadonlyMap<string, string>>();

/**
 * Sanitizes `added` merged over `base` as one object, so every limit holds for the result as a
 * whole: an event's data with its bindings, or a child's bindings with its parent's. `kept` keys
 * come first, then `base` keys, and an `added` key replaces a `base` key in place when both escape
 * to the same name. No `base` or `added` key replaces a `kept` one, and coming first, `kept`
 * fields are never the ones the limits leave out. A `kept` key whose value is `undefined` is
 * written nowhere, so neither `base` nor `added` can supply it.
 *
 * @param base - Bindings that were already sanitized, so reading them runs no caller code and
 *   their keys are already escaped; deciding their redaction again reveals nothing the first
 *   decision redacted
 * @param rememberKeys - Whether the result is a child's bindings, whose changed keys later
 *   events may override
 * @param kept - Fields Routa owns, such as request identity, whose keys need no escaping, and
 *   names it reserves without a value
 * @param identity - The request identity Routa binds, among `kept`. Its fields are never
 *   redacted, so they log the values the response headers carry: no baseline name is an
 *   identity name, and `redact` paths do not apply to them. A path still applies to a field of
 *   the same name deeper in the data.
 * @throws {TypeError} When `added` is not a plain object
 */
function sanitizeMerged(
	base: RoutaLogData,
	added: unknown,
	paths: PendingPaths,
	rememberKeys = false,
	kept: RoutaLogData = {},
	identity: RoutaLogData = {},
): RoutaLogData {
	if (!isPlainObject(added)) {
		throw new TypeError("Log data must be a plain object.");
	}

	const members = new Map<string, Member>();
	const baseKeys = bindingKeys.get(base);
	const originalKeys = new Map<string, string>();
	const isKept = (name: string) => Object.hasOwn(kept, name);

	// A kept name without a value is reserved: no field of that name is written at all.
	for (const name of Object.keys(kept)) {
		if (kept[name] !== undefined) {
			members.set(name, {
				key: name,
				read: () => kept[name],
				...(Object.hasOwn(identity, name) && { identity: true as const }),
			});
		}
	}

	for (const name of Object.keys(base)) {
		if (!isKept(name)) {
			members.set(name, { key: name, read: () => base[name] });
			originalKeys.set(name, baseKeys?.get(name) ?? name);
		}
	}

	// Escaping a key twice changes nothing, so an added key escaped here meets its base key.
	// One key past the limit is enough to mark the merged object as truncated.
	const keys = Object.keys(added);
	const replaced = new Set<string>();
	for (const key of keys.slice(0, maxEntries + 1)) {
		const name = safeText(key);
		replaced.add(name);

		if (!isKept(name)) {
			members.set(name, { key, read: () => memberValue(added, key) });
			originalKeys.set(name, key);
		}
	}

	// An added key past the ones read above still replaces a base key that escapes to the same
	// name, so how many other fields the data holds never decides which value a binding logs.
	// Each binding is looked up by the key it came from, which costs one lookup per binding
	// however many keys the data holds.
	if (keys.length > maxEntries + 1) {
		for (const name of Object.keys(base)) {
			const key = baseKeys?.get(name) ?? name;

			if (
				!replaced.has(name)
				&& !isKept(name)
				&& Object.prototype.propertyIsEnumerable.call(added, key)
			) {
				members.set(name, { key, read: () => memberValue(added, key) });
				originalKeys.set(name, key);
			}
		}
	}

	// The merged object is never built, so `added` stands in for it as the root: a reference back
	// to the data still reads as circular, and depth counts from the data.
	const traversal: Traversal = { ancestors: new Set([added]), remaining: maxValues };

	const merged = sanitizeMembers(members, keys.length > maxEntries + 1, traversal, paths);

	if (rememberKeys) {
		const changed = new Map<string, string>();
		for (const name of Object.keys(merged)) {
			const key = originalKeys.get(name);
			if (key !== undefined && key !== name && key.length <= maxStringLength) {
				changed.set(name, key);
			}
		}
		bindingKeys.set(merged, changed);
	}

	return merged;
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
