import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { createApplication, createHonoApp } from "./hono.js";
import type * as LoggerModule from "./logger.js";
import { createRoute, createRouta } from "./index.js";
import {
	type CreateLoggerOptions,
	createLogger,
	type RoutaLogData,
	type RoutaLogEvent,
	type RoutaLogger,
} from "./logger.js";

const compareText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

describe("createLogger", () => {
	it("emits structured log events", () => {
		const events: RoutaLogEvent[] = [];
		const logger = createLogger({
			now: () => new Date("2026-06-26T00:00:00.000Z"),
			sink: (event) => events.push(event),
		});

		logger.info("api.started", "Routa API started.", { port: 3000 });

		expect(events).toEqual([
			{
				level: "info",
				event: "api.started",
				message: "Routa API started.",
				timestamp: "2026-06-26T00:00:00.000Z",
				data: { port: 3000 },
			},
		]);
	});

	it("supports every standard Routa log level", () => {
		const events: RoutaLogEvent[] = [];
		const logger = createLogger({
			level: "trace",
			now: () => new Date("2026-06-26T00:00:00.000Z"),
			sink: (event) => events.push(event),
		});

		logger.trace("level.trace", "trace");
		logger.debug("level.debug", "debug");
		logger.info("level.info", "info");
		logger.warn("level.warn", "warn");
		logger.error("level.error", "error");
		logger.fatal("level.fatal", "fatal");
		logger.silent("level.silent", "silent");

		expect(events.map((event) => event.level)).toEqual([
			"trace",
			"debug",
			"info",
			"warn",
			"error",
			"fatal",
		]);
	});

	it("supports level checks and child bindings", () => {
		const events: RoutaLogEvent[] = [];
		const logger = createLogger({
			level: "warn",
			now: () => new Date("2026-06-26T00:00:00.000Z"),
			sink: (event) => events.push(event),
		});
		const child = logger.child({ requestId: "req_1" });

		expect(child.bindings()).toEqual({ requestId: "req_1" });
		expect(child.isLevelEnabled("debug")).toBe(false);
		expect(child.isLevelEnabled("warn")).toBe(true);
		expect(child.isLevelEnabled("silent")).toBe(false);

		child.info("request.skipped", "This is below the configured level.");
		child.warn("request.warned", "Request warning.", { route: "/status" });

		expect(events).toEqual([
			{
				level: "warn",
				event: "request.warned",
				message: "Request warning.",
				timestamp: "2026-06-26T00:00:00.000Z",
				data: { requestId: "req_1", route: "/status" },
			},
		]);
	});

	it("implements the complete contract as no-ops when disabled", () => {
		const sink = vi.fn<(event: RoutaLogEvent) => void>();
		const logger = createLogger({ enabled: false, sink });

		for (const level of ["trace", "debug", "info", "warn", "error", "fatal", "silent"] as const) {
			logger[level]("disabled", "Disabled event.");
			expect(logger.isLevelEnabled(level)).toBe(false);
		}
		logger.child({ requestId: "req_1" }).fatal("disabled.child", "Disabled child event.");

		expect(sink).not.toHaveBeenCalled();
	});

	it("never reads what a disabled or silent logger is given", () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const reads = vi.fn();
		const watched = new Proxy(
			{},
			{
				get: reads,
				getOwnPropertyDescriptor: reads,
				ownKeys: () => {
					reads();
					return [];
				},
				getPrototypeOf: () => {
					reads();
					return Object.prototype;
				},
			},
		);
		const sink = vi.fn<(event: RoutaLogEvent) => void>();

		try {
			for (const logger of [
				createLogger({ enabled: false, sink }),
				createLogger({ level: "silent", sink }),
			]) {
				const child = logger.child(watched as RoutaLogData);

				logger.log(watched as RoutaLogEvent);
				child.log(watched as RoutaLogEvent);
				child.fatal("disabled", "Disabled.", watched as RoutaLogData);
				expect(logger.child({ region: "us" }).bindings()).toEqual({});
				expect(child.bindings()).toEqual({});
				expect(Object.isFrozen(child)).toBe(true);
			}

			expect(reads).not.toHaveBeenCalled();
			expect(sink).not.toHaveBeenCalled();
			expect(consoleError).not.toHaveBeenCalled();
		} finally {
			consoleError.mockRestore();
		}
	});
});

describe("createLogger sanitization", () => {
	function capture(options: Parameters<typeof createLogger>[0] = {}) {
		const events: RoutaLogEvent[] = [];
		const logger = createLogger({
			now: () => new Date("2026-06-26T00:00:00.000Z"),
			...options,
			sink: (event) => events.push(event),
		});
		return { events, logger };
	}

	it("LOG-AC-03 redacts baseline sensitive names in nested objects and arrays", () => {
		const { events, logger } = capture();

		logger.info("login", "Signed in.", {
			user: { name: "ada", password: "hunter2" },
			attempts: [{ token: "t1" }, { Authorization: "Bearer x" }],
		});

		expect(events[0]?.data).toEqual({
			user: { name: "ada", password: "[Redacted]" },
			attempts: [{ token: "[Redacted]" }, { Authorization: "[Redacted]" }],
		});
	});

	it("LOG-AC-04 replaces cycles with a marker and keeps shared references", () => {
		const { events, logger } = capture();
		const shared = { id: 1 };
		const circular: Record<string, unknown> = { shared, again: shared };
		circular.self = circular;
		circular.list = [circular];

		logger.info("cycle", "Cycle.", { circular });

		expect(events[0]?.data).toEqual({
			circular: {
				shared: { id: 1 },
				again: { id: 1 },
				self: "[Circular]",
				list: ["[Circular]"],
			},
		});
	});

	it("LOG-AC-04 never calls getters or custom toJSON methods", () => {
		const { events, logger } = capture();
		let getterCalls = 0;
		let toJSONCalls = 0;
		const account = {
			id: "acct_1",
			get balance() {
				getterCalls += 1;
				return 100;
			},
			toJSON() {
				toJSONCalls += 1;
				return { leaked: true };
			},
		};
		const list = [1];
		Object.defineProperty(list, 0, {
			enumerable: true,
			get() {
				getterCalls += 1;
				return 2;
			},
		});

		logger.info("account.read", "Account read.", { account, list });
		const line = JSON.stringify(events[0]);

		expect(getterCalls).toBe(0);
		expect(toJSONCalls).toBe(0);
		expect(events[0]?.data).toEqual({
			account: { id: "acct_1", balance: "[Unsupported]", toJSON: "[Unsupported]" },
			list: ["[Unsupported]"],
		});
		expect(JSON.parse(line).data).toEqual(events[0]?.data);
		expect(toJSONCalls).toBe(0);
	});

	it("LOG-AC-04 keeps JSON values and replaces everything else with a marker", () => {
		const { events, logger } = capture();
		class Account {
			id = "acct_1";
		}
		// oxlint-disable-next-line no-sparse-arrays -- a hole must read as null, as in JSON.
		const sparse = [1, , 3];

		logger.info("values", "Values.", {
			text: "ok",
			count: 3,
			ratio: Number.NaN,
			enabled: false,
			none: null,
			missing: undefined,
			id: 12345678901234567890n,
			at: new Date("2026-06-26T00:00:00.000Z"),
			invalidAt: new Date("not a date"),
			sparse,
			listed: [undefined, () => undefined],
			account: new Account(),
			map: new Map([["k", "v"]]),
			error: new Error("database password is hunter2"),
			bytes: new Uint8Array([1, 2]),
			run: () => undefined,
			tag: Symbol("tag"),
			[Symbol("hidden")]: "not a string key",
			nullPrototype: Object.assign(Object.create(null), { ok: true }),
		});
		const data = events[0]?.data;

		expect(data).toEqual({
			text: "ok",
			count: 3,
			ratio: null,
			enabled: false,
			none: null,
			id: "12345678901234567890",
			at: "2026-06-26T00:00:00.000Z",
			invalidAt: null,
			sparse: [1, null, 3],
			listed: [null, "[Unsupported]"],
			account: "[Unsupported]",
			map: "[Unsupported]",
			error: "[Unsupported]",
			bytes: "[Unsupported]",
			run: "[Unsupported]",
			tag: "[Unsupported]",
			nullPrototype: { ok: true },
		});
		expect(data && "missing" in data).toBe(false);
		expect(JSON.parse(JSON.stringify(data))).toEqual(data);
	});

	it("LOG-AC-04 escapes control characters in every emitted string", () => {
		const { events, logger } = capture();
		const forged = 'ok\n{"level":"fatal"}\r\t\u001b[31m\u007f\u0085\u2028\u202e\u0000';
		const escaped = 'ok\\n{"level":"fatal"}\\r\\t\\u001b[31m\\u007f\\u0085\\u2028\\u202e\\u0000';

		logger.info(`event${forged}`, `message${forged}`, {
			[`key${forged}`]: `value${forged}`,
			nested: [{ deep: forged }],
		});

		expect(events[0]).toMatchObject({
			event: `event${escaped}`,
			message: `message${escaped}`,
			data: { [`key${escaped}`]: `value${escaped}`, nested: [{ deep: escaped }] },
		});
		expect(JSON.stringify(events[0])).not.toMatch(
			// oxlint-disable-next-line no-control-regex -- no control character may reach the sink.
			/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e]/,
		);
	});

	it("LOG-AC-03 sanitizes direct log(event) calls and leaves the event unchanged", () => {
		const { events, logger } = capture();
		const data = { user: { password: "hunter2", name: "ada" }, tokenCount: 3 };
		const event = {
			level: "warn" as const,
			event: "direct\nforged",
			message: "Direct\rmessage",
			timestamp: "2026-06-26T00:00:00.000Z\n",
			data,
			extra: "dropped",
		};
		const before = structuredClone(event);

		logger.log(event);

		expect(events).toEqual([
			{
				level: "warn",
				event: "direct\\nforged",
				message: "Direct\\rmessage",
				timestamp: "2026-06-26T00:00:00.000Z\\n",
				data: { user: { password: "[Redacted]", name: "ada" }, tokenCount: 3 },
			},
		]);
		expect(event).toEqual(before);
		expect(events[0]?.data).not.toBe(data);
	});

	it("LOG-AC-03 sanitizes child bindings once, as a snapshot, before every sink call", () => {
		const events: RoutaLogEvent[] = [];
		const logger = createLogger({
			now: () => new Date("2026-06-26T00:00:00.000Z"),
			sink: (event) => {
				events.push(structuredClone(event));
				// A sink that mutates its event cannot change later events.
				const session = event.data?.session as { id?: string } | undefined;
				if (session) {
					session.id = "changed";
				}
			},
		});
		const bindings = { session: { id: "s_1", cookie: "sid=abc" }, "line\nbreak": "x" };
		const before = structuredClone(bindings);
		const child = logger.child(bindings).child({ apiKey: "k_1" });

		bindings.session.id = "mutated";
		child.info("first", "First.", { session: { id: "override" } });
		child.info("second", "Second.");

		expect(bindings).toEqual({ ...before, session: { ...before.session, id: "mutated" } });
		expect(child.bindings()).toEqual({
			session: { id: "s_1", cookie: "[Redacted]" },
			"line\\nbreak": "x",
			apiKey: "[Redacted]",
		});
		expect(events.map((event) => event.data)).toEqual([
			{ session: { id: "override" }, "line\\nbreak": "x", apiKey: "[Redacted]" },
			{ session: { id: "s_1", cookie: "[Redacted]" }, "line\\nbreak": "x", apiKey: "[Redacted]" },
		]);
	});

	it("LOG-AC-03 matches sensitive names case-insensitively without substring matches", () => {
		const { events, logger } = capture();
		const redacted = [
			"authorization",
			"Proxy-Authorization",
			"cookie",
			"Set-Cookie",
			"password",
			"PASSWORD",
			"passphrase",
			"secret",
			"client_secret",
			"token",
			"access_token",
			"refreshToken",
			"id_token",
			"authToken",
			"x-auth-token",
			"sessionToken",
			"session_id",
			"csrfToken",
			"X-CSRF-Token",
			"apiKey",
			"api_key",
			"X-API-Key",
			"privateKey",
		];
		const kept = ["tokenCount", "passwordHint", "secretary", "cookies_enabled", "session", "key"];

		logger.info(
			"names",
			"Names.",
			Object.fromEntries([...redacted, ...kept].map((name) => [name, "v"])),
		);

		expect(events[0]?.data).toEqual(
			Object.fromEntries([
				...redacted.map((name) => [name, "[Redacted]"]),
				...kept.map((name) => [name, "v"]),
			]),
		);
	});

	it("LOG-AC-03 redacts custom paths in data and child bindings", () => {
		const { events, logger } = capture({
			redact: ["ssn", "user.email", "orders.*.card", "headers.X-Tenant-Key", "matrix.0.1"],
		});

		logger.child({ user: { email: "ada@example.com", name: "ada" } }).info("order", "Order.", {
			ssn: { area: 123 },
			orders: [{ card: "4242", total: 5 }, { card: "1111" }],
			headers: { "x-tenant-key": "k", accept: "*/*" },
			matrix: [
				[1, 2],
				[3, 4],
			],
			nested: { ssn: "not a root path", email: "not under user" },
		});

		expect(events[0]?.data).toEqual({
			user: { email: "[Redacted]", name: "ada" },
			ssn: "[Redacted]",
			orders: [{ card: "[Redacted]", total: 5 }, { card: "[Redacted]" }],
			headers: { "x-tenant-key": "[Redacted]", accept: "*/*" },
			matrix: [
				[1, "[Redacted]"],
				[3, 4],
			],
			nested: { ssn: "not a root path", email: "not under user" },
		});
	});

	it("LOG-AC-04 keeps baseline redaction whatever the options", () => {
		const { events, logger } = capture({ redact: [], level: "trace" });

		logger.trace("baseline", "Baseline.", { password: "hunter2" });

		expect(events[0]?.data).toEqual({ password: "[Redacted]" });
	});

	it("LOG-AC-04 bounds depth, entries, total values, and string length", () => {
		const { events, logger } = capture();
		let deep: Record<string, unknown> = { leaf: true };
		for (let level = 0; level < 50; level += 1) {
			deep = { next: deep };
		}
		const wide = Array.from({ length: 150 }, (_, index) => index);
		const keyed = Object.fromEntries(wide.map((index) => [`k${index}`, index]));
		const grid = Array.from({ length: 100 }, () => Array.from({ length: 100 }, () => 1));

		logger.info("bounds", "x".repeat(10_000), {
			deep,
			wide,
			keyed,
			// oxlint-disable-next-line unicorn/no-new-array -- a huge sparse array is the hostile input.
			sparse: new Array(10_000_000),
			long: `${"y".repeat(5000)}\u{1F600}`,
		});
		logger.info("budget", "Budget.", { grid });
		const [bounded, budget] = events;

		let depth = 0;
		let cursor: unknown = bounded?.data?.deep;
		while (typeof cursor === "object" && cursor !== null) {
			depth += 1;
			cursor = (cursor as { next?: unknown }).next;
		}
		expect(depth).toBe(10);
		expect(cursor).toBe("[Truncated]");
		expect(bounded?.data?.wide).toEqual([...wide.slice(0, 100), "[Truncated]"]);
		expect(Object.keys(bounded?.data?.keyed as object)).toHaveLength(101);
		expect(bounded?.data?.keyed).toMatchObject({ k99: 99, "[Truncated]": "[Truncated]" });
		expect(bounded?.data?.keyed).not.toHaveProperty("k100");
		expect(bounded?.data?.sparse).toHaveLength(101);
		expect(bounded?.message).toHaveLength(4096);
		expect(bounded?.message.endsWith("x[Truncated]")).toBe(true);
		expect(bounded?.data?.long).toBe(`${"y".repeat(4096 - 11)}[Truncated]`);

		const values = JSON.stringify(budget?.data).match(/1|"\[Truncated\]"/g) ?? [];
		expect(values.filter((value) => value === "1").length).toBeLessThan(1000);
		expect(JSON.stringify(budget?.data)).toContain("[Truncated]");
	});

	it("LOG-AC-04 holds the limits for each event's bindings and data together", () => {
		const { events, logger } = capture();
		const keys = (prefix: string) =>
			Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`${prefix}${index}`, index]));
		const rows = (value: number) =>
			Array.from({ length: 9 }, () => Array.from({ length: 99 }, () => value));
		/** Every value in the event's data except truncation markers, nested containers included. */
		const countValues = (value: unknown): number =>
			typeof value === "object" && value !== null
				? Object.values(value).reduce<number>(
						(total, item) => total + (item === "[Truncated]" ? 0 : 1) + countValues(item),
						0,
					)
				: 0;

		let chained = logger;
		for (let child = 0; child < 15; child += 1) {
			chained = chained.child(keys(`c${child}_`));
		}
		chained.info("chained", "Chained.", keys("d"));
		logger.child({ bindings: rows(1) }).info("budget", "Budget.", { data: rows(2) });
		const [wide, budget] = events;

		expect(Object.keys(chained.bindings())).toHaveLength(101);
		expect(Object.keys(wide?.data as object)).toHaveLength(101);
		expect(wide?.data).toMatchObject({ c0_0: 0, c0_99: 99, "[Truncated]": "[Truncated]" });
		expect(wide?.data).not.toHaveProperty("c1_0");
		expect(wide?.data).not.toHaveProperty("d0");
		expect(countValues(budget?.data)).toBeLessThanOrEqual(1000);
		expect(budget?.data?.bindings).toEqual(rows(1));
		expect(JSON.stringify(budget?.data?.data)).toContain("[Truncated]");
	});
});

describe("createLogger failure containment", () => {
	function hostile(secret: string): object {
		return new Proxy(
			{},
			{
				ownKeys() {
					throw new Error(`trap saw ${secret}`);
				},
			},
		);
	}

	function fallbackLines(spy: { mock: { calls: unknown[][] } }): Array<Record<string, unknown>> {
		return spy.mock.calls.map(([line]) => JSON.parse(String(line)) as Record<string, unknown>);
	}

	it("LOG-AC-05 discards an event it cannot sanitize and reports it once without its data", () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const sink = vi.fn<(event: RoutaLogEvent) => void>();
		const logger = createLogger({ sink });

		try {
			expect(() => logger.info("unsafe", "Unsafe.", { body: hostile("hunter2") })).not.toThrow();
			expect(() =>
				logger.log({
					level: "info",
					event: "unsafe",
					message: "Unsafe.",
					timestamp: "now",
					data: hostile("hunter2") as Record<string, unknown>,
				}),
			).not.toThrow();
			const child = logger.child(hostile("hunter2") as Record<string, unknown>);
			child.info("child", "Child of unsafe bindings.");
			logger.info("safe", "Still delivered.");

			expect(sink.mock.calls.map(([event]) => event.event)).toEqual(["safe"]);
			expect(child.bindings()).toEqual({});
			expect(consoleError).toHaveBeenCalledTimes(1);
			const output = String(consoleError.mock.calls[0]?.[0]);
			expect(output).not.toContain("hunter2");
			expect(output).not.toContain("Unsafe");
			expect(fallbackLines(consoleError)).toEqual([
				{
					level: "error",
					event: "routa.logger.event_discarded",
					message:
						"A Routa logger discarded an event it could not sanitize. Later discarded events from this logger are not reported.",
					timestamp: expect.any(String),
				},
			]);
		} finally {
			consoleError.mockRestore();
		}
	});

	it("LOG-AC-05 discards an event whose clock fails", () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const sink = vi.fn<(event: RoutaLogEvent) => void>();
		const logger = createLogger({
			sink,
			now: () => {
				throw new Error("clock broke");
			},
		});

		try {
			expect(() => logger.warn("tick", "Tick.")).not.toThrow();
			expect(sink).not.toHaveBeenCalled();
			expect(fallbackLines(consoleError).map((line) => line.event)).toEqual([
				"routa.logger.event_discarded",
			]);
		} finally {
			consoleError.mockRestore();
		}
	});

	it("LOG-AC-05 contains throwing and rejecting sinks and reports sink failure once", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const unhandled = vi.fn<(reason: unknown) => void>();
		process.on("unhandledRejection", unhandled);
		let calls = 0;
		const logger = createLogger({
			sink: (event) => {
				calls += 1;
				if (event.event === "throws") {
					throw new Error(`sink saw ${event.message}`);
				}
				return Promise.reject(new Error(`sink saw ${event.message}`)) as unknown as void;
			},
		});

		try {
			for (let index = 0; index < 5; index += 1) {
				expect(() => logger.info("throws", "secret message")).not.toThrow();
				expect(() => logger.child({ index }).info("rejects", "secret message")).not.toThrow();
			}
			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(calls).toBe(10);
			expect(unhandled).not.toHaveBeenCalled();
			expect(consoleError).toHaveBeenCalledTimes(1);
			expect(String(consoleError.mock.calls[0]?.[0])).not.toContain("secret");
			expect(fallbackLines(consoleError)).toEqual([
				{
					level: "error",
					event: "routa.logger.sink_failed",
					message:
						"A Routa logger sink threw or rejected. Later sink failures from this logger are not reported.",
					timestamp: expect.any(String),
				},
			]);
		} finally {
			process.off("unhandledRejection", unhandled);
			consoleError.mockRestore();
		}
	});

	it("LOG-AC-05 reports a failing console sink without retrying it", () => {
		const consoleLog = vi.spyOn(console, "log").mockImplementation(() => {
			throw new Error("stdout closed");
		});
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {
			throw new Error("stderr closed");
		});
		const logger = createLogger();

		try {
			expect(() => logger.info("a", "A.")).not.toThrow();
			expect(() => logger.error("b", "B.")).not.toThrow();
			expect(consoleLog).toHaveBeenCalledTimes(1);
			// The error event and one fallback line; the fallback never calls the sink again.
			expect(consoleError).toHaveBeenCalledTimes(2);
		} finally {
			consoleLog.mockRestore();
			consoleError.mockRestore();
		}
	});

	it("LOG-AC-02 writes one JSON line per event to the console at info by default", () => {
		const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
		const consoleWarn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const logger = createLogger({ now: () => new Date("2026-06-26T00:00:00.000Z") });

		try {
			logger.debug("hidden", "Below info.");
			logger.info("api.started", "Routa API started.", { port: 3000, password: "hunter2" });
			logger.warn("api.slow", "Slow.\nNext line");
			logger.error("api.failed", "Failed.");
			logger.fatal("api.down", "Down.");

			expect(consoleLog.mock.calls).toEqual([
				[
					'{"timestamp":"2026-06-26T00:00:00.000Z","level":"info","event":"api.started","message":"Routa API started.","data":{"port":3000,"password":"[Redacted]"}}',
				],
			]);
			expect(consoleWarn.mock.calls).toEqual([
				[
					'{"timestamp":"2026-06-26T00:00:00.000Z","level":"warn","event":"api.slow","message":"Slow.\\\\nNext line"}',
				],
			]);
			expect(consoleError.mock.calls.map(([line]) => JSON.parse(String(line)).level)).toEqual([
				"error",
				"fatal",
			]);
		} finally {
			consoleLog.mockRestore();
			consoleWarn.mockRestore();
			consoleError.mockRestore();
		}
	});
});

describe("createLogger options", () => {
	it("rejects options it cannot honor before any event is written", () => {
		const invalid: Array<[unknown, string]> = [
			[
				{ level: "verbose" },
				'createLogger level must be one of "trace", "debug", "info", "warn", "error", "fatal", "silent".',
			],
			[
				{ sink: "stdout" },
				"createLogger sink must be a function that receives each sanitized event.",
			],
			[{ now: Date.now() }, "createLogger now must be a function that returns a Date."],
			[{ enabled: "yes" }, "createLogger enabled must be a boolean."],
			[
				{ redact: "password" },
				'createLogger redact must be an array of field paths, such as ["user.email"].',
			],
			[
				{ redact: ["user..email"] },
				'createLogger redact path "user..email" has an empty segment. Separate field names with single dots, such as "user.email".',
			],
			[
				{ redact: [""] },
				'createLogger redact path "" has an empty segment. Separate field names with single dots, such as "user.email".',
			],
			[
				{ redact: [42] },
				'createLogger redact must be an array of field paths, such as ["user.email"].',
			],
			[
				{ redact: { paths: ["user.email"] } },
				'createLogger redact must be an array of field paths, such as ["user.email"].',
			],
			[
				{ level: "info", transport: {} },
				'createLogger does not accept "transport". It accepts enabled, level, sink, redact, and now; send events to another backend from a sink.',
			],
			["info", "createLogger options must be an object."],
		];

		for (const [options, message] of invalid) {
			expect(() => createLogger(options as CreateLoggerOptions)).toThrow(new TypeError(message));
		}
	});
});

describe("factory-created loggers", () => {
	const customLogger = {
		log: () => undefined,
		trace: () => undefined,
		debug: () => undefined,
		info: () => undefined,
		warn: () => undefined,
		error: () => undefined,
		fatal: () => undefined,
		silent: () => undefined,
		child: () => customLogger,
		bindings: () => ({}),
		isLevelEnabled: () => true,
	};

	it("LOG-AC-01 types accept createLogger loggers and reject structural lookalikes", () => {
		const logger: RoutaLogger = createLogger({ sink: () => undefined });
		const child: RoutaLogger = logger.child({ service: "billing" });
		createRouta({ logger });
		createRouta({ logger: child });
		createRouta({ logger: false });
		createRouta({});
		// @ts-expect-error Routa accepts only loggers that createLogger created.
		createRouta({ logger: customLogger });
		// @ts-expect-error Routa accepts only loggers that createLogger created.
		const lookalike: RoutaLogger = customLogger;

		expect(lookalike).toBe(customLogger);
	});

	it("LOG-AC-01 refuses a logger createLogger did not create, with the migration", async () => {
		const migration =
			"Routa accepts only loggers from createLogger, so redaction runs before any output. Forward events to your backend from a sink instead: logger: createLogger({ sink: (event) => backend.write(event) }). Set logger: false to turn logging off.";
		const unsafe = customLogger as unknown as RoutaLogger;

		expect(() => createHonoApp([], { logger: unsafe })).toThrow(
			new TypeError(
				`createHonoApp received a logger that createLogger did not create. ${migration}`,
			),
		);
		await expect(createApplication([], { logger: unsafe })).rejects.toThrow(
			new TypeError(
				`createApplication received a logger that createLogger did not create. ${migration}`,
			),
		);
		expect(() => createHonoApp([], { logger: createLogger({ enabled: false }) })).not.toThrow();
	});

	it("LOG-AC-01 keeps writing to the logger it checked when the options change later", async () => {
		const events: string[] = [];
		const swapped = { ...customLogger, info: vi.fn() };
		const routes = [
			{
				method: "get" as const,
				path: "/status",
				contract: createRoute({
					responses: { ok: { status: 200, schema: z.object({ ok: z.boolean() }) } },
					run: () => ({ type: "ok" as const, data: { ok: true } }),
				}),
			},
		];
		const honoOptions = { logger: createLogger({ sink: (event) => events.push(event.event) }) };
		const applicationOptions = { ...honoOptions };
		const hono = createHonoApp(routes, honoOptions);
		const application = await createApplication(routes, applicationOptions);

		honoOptions.logger = swapped as unknown as RoutaLogger;
		applicationOptions.logger = swapped as unknown as RoutaLogger;
		await hono.request("/status");
		await application.fetch(new Request("http://localhost/status"));

		expect(events).toEqual(["http.request", "http.request"]);
		expect(swapped.info).not.toHaveBeenCalled();
	});

	it("LOG-AC-01 refuses an object whose brand is not the factory's own true value", () => {
		const brand = Symbol.for("@routa-ts/core/createLogger");
		const getter = vi.fn(() => true);
		const forged = [
			{ ...customLogger, [brand]: false },
			{ ...customLogger, [brand]: "true" },
			Object.defineProperty({ ...customLogger }, brand, { get: getter }),
			Object.create({ [brand]: true }),
		];

		for (const logger of forged) {
			expect(() => createHonoApp([], { logger: logger as RoutaLogger })).toThrow(
				"createHonoApp received a logger that createLogger did not create.",
			);
		}
		expect(getter).not.toHaveBeenCalled();
	});

	it("LOG-AC-05 keeps request results when a configured sink throws, rejects, or data is unsafe", async () => {
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
		const unhandled = vi.fn<(reason: unknown) => void>();
		process.on("unhandledRejection", unhandled);
		const delivered: string[] = [];
		const route = (sink: (event: RoutaLogEvent) => void) =>
			createHonoApp(
				[
					{
						method: "get",
						path: "/status",
						contract: createRoute({
							responses: { ok: { status: 200, schema: z.object({ ok: z.boolean() }) } },
							run: ({ ctx }) => {
								ctx.logger.info("status.read", "Status read.");
								ctx.logger.warn("status.unsafe", "Unsafe data.", {
									body: new Proxy(
										{},
										{
											ownKeys() {
												throw new Error("trap");
											},
										},
									),
								});
								ctx.logger.child({ route: "/status" }).error("status.child", "Child.");
								return { type: "ok", data: { ok: true } };
							},
						}),
					},
				],
				{ logger: createLogger({ sink }) },
			);

		try {
			for (const sink of [
				(event: RoutaLogEvent) => {
					delivered.push(event.event);
					throw new Error("sink down");
				},
				(event: RoutaLogEvent) => {
					delivered.push(event.event);
					return Promise.reject(new Error("sink down")) as unknown as void;
				},
			]) {
				const response = await route(sink).request("/status");

				expect(response.status).toBe(200);
				expect(await response.json()).toEqual({ ok: true });
			}
			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(delivered).toEqual([
				"status.read",
				"status.child",
				"http.request",
				"status.read",
				"status.child",
				"http.request",
			]);
			expect(unhandled).not.toHaveBeenCalled();
			// Each logger reports each kind of failure once; a rejection reports after the request.
			expect(
				consoleError.mock.calls
					.map(([line]) => String(JSON.parse(String(line)).event))
					.sort(compareText),
			).toEqual([
				"routa.logger.event_discarded",
				"routa.logger.event_discarded",
				"routa.logger.sink_failed",
				"routa.logger.sink_failed",
			]);
		} finally {
			process.off("unhandledRejection", unhandled);
			consoleError.mockRestore();
		}
	});

	it("LOG-AC-01 accepts a logger another copy of @routa-ts/core created", async () => {
		// The CLI runs the application with its own copy of the package, which may not be the copy
		// src/routa.ts imported createLogger from.
		const specifier = "./logger.js?copy";
		const copy = (await import(/* @vite-ignore */ specifier)) as typeof LoggerModule;
		const events: RoutaLogEvent[] = [];
		const logger = copy.createLogger({ sink: (event) => events.push(event) });

		expect(copy.createLogger).not.toBe(createLogger);
		expect(() => createHonoApp([], { logger })).not.toThrow();
		expect(Object.isFrozen(logger)).toBe(true);
		expect(Object.isFrozen(logger.child({ a: 1 }))).toBe(true);
	});
});
