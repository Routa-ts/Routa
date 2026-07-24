import { describe, expect, it, vi } from "vitest";
import { createLogger, type RoutaLogEvent } from "./logger.js";

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

	it("does not throw when console log data is not serializable", () => {
		const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
		const logger = createLogger({
			now: () => new Date("2026-06-26T00:00:00.000Z"),
		});
		const circular: Record<string, unknown> = {};
		circular.self = circular;

		try {
			expect(() => logger.info("api.started", "Routa API started.", circular)).not.toThrow();
			expect(consoleLog).toHaveBeenCalledWith(expect.stringContaining("[unserializable]"));
		} finally {
			consoleLog.mockRestore();
		}
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
		const sink = vi.fn();
		const logger = createLogger({ enabled: false, sink });

		for (const level of ["trace", "debug", "info", "warn", "error", "fatal", "silent"] as const) {
			logger[level]("disabled", "Disabled event.");
			expect(logger.isLevelEnabled(level)).toBe(false);
		}
		logger.child({ requestId: "req_1" }).fatal("disabled.child", "Disabled child event.");

		expect(sink).not.toHaveBeenCalled();
	});
});
