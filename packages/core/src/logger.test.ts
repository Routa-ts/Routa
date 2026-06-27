import { describe, expect, it } from "vitest";
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
});
