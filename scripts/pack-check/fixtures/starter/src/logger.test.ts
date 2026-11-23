import { createLogger, type RoutaLogEvent, type RoutaLogger } from "@routa-ts/core";
import { createLogger as createFromSubpath } from "@routa-ts/core/logger";
import { expect, it, vi } from "vitest";

const ignore = () => undefined;
// Every RoutaLogger member, so the factory brand is the only thing missing.
// @ts-expect-error Routa accepts only loggers that createLogger created.
const handWritten: RoutaLogger = {
	log: ignore,
	trace: ignore,
	debug: ignore,
	info: ignore,
	warn: ignore,
	error: ignore,
	fatal: ignore,
	silent: ignore,
	child: () => handWritten,
	bindings: () => ({}),
	isLevelEnabled: () => true,
};

it("redacts before the sink and writes JSON by default", () => {
	const events: RoutaLogEvent[] = [];
	const body = { user: { email: "ada@example.com" }, tokenCount: 1 };
	const logger: RoutaLogger = createLogger({
		redact: ["user.email"],
		sink: (event) => {
			events.push(event);
		},
	});
	logger.child({ authorization: "Bearer demo" }).info("user.read", "Read\nuser.", body);

	expect(events[0]?.message).toBe("Read\\nuser.");
	expect(events[0]?.data).toEqual({
		authorization: "[Redacted]",
		user: { email: "[Redacted]" },
		tokenCount: 1,
	});
	expect(body.user.email).toBe("ada@example.com");

	const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
	try {
		createFromSubpath().info("app.ready", "Ready.", { password: "hunter2" });
		expect(JSON.parse(String(log.mock.calls[0]?.[0])).data).toEqual({ password: "[Redacted]" });
	} finally {
		log.mockRestore();
	}
	expect(handWritten).toBeDefined();
});
