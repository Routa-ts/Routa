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
});
