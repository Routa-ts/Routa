/**
 * Writes one event through the example's Pino sink and asserts the line Pino produces: event data
 * whose keys match Pino's own fields (`level`, `time`, `msg`, `pid`, `hostname`) stays under
 * `data` and cannot change the level, message, or timestamp.
 *
 * Usage: pnpm pino:exercise
 */
import assert from "node:assert/strict";
import { createLogger } from "@routa-ts/core";
import pino from "pino";
import { pinoSink } from "../src/logger.js";

const lines: string[] = [];
const output = pino({ level: "trace" }, { write: (line: string) => lines.push(line) });
const logger = createLogger({ sink: pinoSink(output) });
const data = {
	level: 60,
	time: "forged",
	msg: "forged",
	pid: 0,
	hostname: "forged",
	orderId: "o_1",
};

logger.info("order.placed", "Order placed.", data);

assert.equal(lines.length, 1);
const line = JSON.parse(lines[0] ?? "") as Record<string, unknown>;

assert.equal(line.level, 30, "an info event stays at Pino's info level");
assert.equal(line.msg, "Order placed.");
assert.equal(line.event, "order.placed");
assert.equal(line.pid, process.pid);
assert.notEqual(line.time, "forged");
assert.notEqual(line.hostname, "forged");
assert.deepEqual(line.data, data);

const { level, msg, event } = line;
console.log(
	`Pino sink kept event data under data: ${JSON.stringify({ level, msg, event, data: line.data })}`,
);
