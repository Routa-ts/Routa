/**
 * Builds the example's logger as `src/logger.ts` does, with Pino's output captured, and asserts
 * what Pino writes: `LOG_LEVEL` alone decides which levels pass, and event data whose keys match
 * Pino's own fields (`level`, `time`, `msg`, `pid`, `hostname`) stays under `data` and cannot
 * change the level, message, or timestamp. It then serves one request through that logger: the
 * request logger a handler passes to `ProjectAudit` carries the request and correlation IDs, and
 * the shared logger the same handler imports carries neither.
 *
 * Usage: pnpm pino:exercise
 */
import assert from "node:assert/strict";
import { createRoute } from "@routa-ts/core";
import { createHonoApp } from "@routa-ts/core/hono";
import { createAppLogger, type LoggerEnvironment } from "../src/logger.js";
import { ProjectAudit } from "../src/services.js";

/** The example's logger for these environment variables, and the lines its Pino instance writes. */
function capture(environment: LoggerEnvironment) {
	const lines: Array<Record<string, unknown>> = [];
	const logger = createAppLogger(environment, {
		write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>),
	});

	return { lines, logger };
}

const traced = capture({ LOG_LEVEL: "trace" });
traced.logger.trace("order.inspected", "Order inspected.");
traced.logger.debug("order.checked", "Order checked.");
assert.deepEqual(
	traced.lines.map((line) => [line.event, line.level]),
	[
		["order.inspected", 10],
		["order.checked", 20],
	],
	"LOG_LEVEL=trace writes trace and debug events, so Pino's own level filters nothing",
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
	`Pino wrote trace and debug only at LOG_LEVEL=trace and kept event data under data: ${JSON.stringify({ level, msg, event, data: line.data })}`,
);

// One request through the same logger: a service given ctx.logger logs with the request's
// identity; the shared logger, imported directly, logs without it.
const served = capture({});
const app = createHonoApp(
	[
		{
			method: "post",
			path: "/projects",
			contract: createRoute({
				responses: { created: { status: 201 } },
				run: ({ ctx }) => {
					const audit = new ProjectAudit();
					audit.record({ id: "project_new", tenantId: "acme", name: "Atlas", status: "active" });
					audit.flush(ctx.logger);
					served.logger.info("projects.shared", "Logged through the shared logger.");
					return { type: "created" };
				},
			}),
		},
	],
	{ logger: served.logger, correlation: true },
);
const response = await app.request("/projects", {
	method: "POST",
	headers: { "x-request-id": "spoofed", "x-correlation-id": "checkout-42" },
});
const requestId = response.headers.get("x-request-id");
const logged = Object.fromEntries(served.lines.map((entry) => [entry.event, entry.data]));

assert.equal(response.status, 201);
assert.notEqual(
	requestId,
	"spoofed",
	"Routa generates x-request-id instead of trusting the client",
);
assert.equal(response.headers.get("x-correlation-id"), "checkout-42");
assert.deepEqual(
	logged["projects.created"],
	{ requestId, correlationId: "checkout-42", projectId: "project_new" },
	"the service given ctx.logger logs with the request's identity",
);
assert.equal(logged["projects.shared"], undefined, "the shared logger has no request identity");
assert.deepEqual(logged["http.response.prepared"], {
	requestId,
	correlationId: "checkout-42",
	method: "POST",
	route: "/projects",
	status: 201,
	durationMs: (logged["http.response.prepared"] as { durationMs: number }).durationMs,
});

console.log(
	`Pino wrote the request's identity only through ctx.logger: ${JSON.stringify(logged["projects.created"])}`,
);
