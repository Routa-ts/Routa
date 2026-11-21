/**
 * Builds the example's logger as `src/logger.ts` does, with Pino's output captured, and asserts
 * what Pino writes: `LOG_LEVEL` alone decides which levels pass, and event data whose keys match
 * Pino's own fields (`level`, `time`, `msg`, `pid`, `hostname`) stays under `data` and cannot
 * change the level, message, or timestamp.
 *
 * Usage: pnpm pino:exercise
 */
import assert from "node:assert/strict";
import { createAppLogger, type LoggerEnvironment } from "../src/logger.js";

/** The example's logger for these environment variables, and the lines its Pino instance writes. */
function capture(environment: LoggerEnvironment) {
	const lines: Array<Record<string, unknown>> = [];
	const logger = createAppLogger(environment, {
		write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>),
	});

	return { lines, logger };
}

const traced = capture({ LOG_LEVEL: "trace" });
traced.logger.debug("order.checked", "Order checked.");
assert.deepEqual(
	traced.lines.map((line) => line.event),
	["order.checked"],
	"LOG_LEVEL=trace writes a debug event, so Pino's own level filters nothing",
);

const byDefault = capture({});
byDefault.logger.debug("order.checked", "Order checked.");
assert.equal(byDefault.lines.length, 0, "the default info level drops a debug event");

const data = {
	level: 60,
	time: "forged",
	msg: "forged",
	pid: 0,
	hostname: "forged",
	orderId: "o_1",
};
byDefault.logger.info("order.placed", "Order placed.", data);

assert.equal(byDefault.lines.length, 1);
const line = byDefault.lines[0] ?? {};

assert.equal(line.level, 30, "an info event stays at Pino's info level");
assert.equal(line.msg, "Order placed.");
assert.equal(line.event, "order.placed");
assert.equal(line.pid, process.pid);
assert.notEqual(line.time, "forged");
assert.notEqual(line.hostname, "forged");
assert.deepEqual(line.data, data);

const { level, msg, event } = line;
console.log(
	`Pino wrote debug only at LOG_LEVEL=trace and kept event data under data: ${JSON.stringify({ level, msg, event, data: line.data })}`,
);
