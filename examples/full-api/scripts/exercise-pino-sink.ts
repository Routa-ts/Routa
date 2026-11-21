/**
 * Builds the example's logger as `src/logger.ts` does, with Pino's output captured, and asserts
 * what Pino writes: `LOG_LEVEL` alone decides which levels pass, and event data whose keys match
 * Pino's own fields (`level`, `time`, `msg`, `pid`, `hostname`) stays under `data` and cannot
 * change the level, message, or timestamp.
 *
 * It then runs this script again as a child, in `serve` mode, which builds the real application
 * with the generated `createTestApp`: `src/routa.ts`, the shared logger in `src/logger.ts`, the
 * services in `src/services.ts`, and the real routes. Pino writes that application's events to the
 * child's stdout as JSON, the production format. The parent asserts that the project catalog's
 * `projects.catalog_ready`, written through the shared logger, carries no request identity, and
 * that `projects.created`, which the projects route logs by passing `ctx.logger` to
 * `ProjectAudit.flush`, carries the request and correlation IDs.
 *
 * Usage: pnpm pino:exercise
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createAppLogger, type LoggerEnvironment } from "../src/logger.js";

const sessionSecret = "exercise-only-secret";

/** What the child reports about the response, on a line of its own beside Pino's lines. */
type Served = {
	exercise: { status: number; requestId: string | null; correlationId: string | null };
};

if (process.argv[2] === "serve") {
	await serve();
} else {
	exerciseSink();
	exerciseApplication();
}

/** The example's logger for these environment variables, and the lines its Pino instance writes. */
function capture(environment: LoggerEnvironment) {
	const lines: Array<Record<string, unknown>> = [];
	const logger = createAppLogger(environment, {
		write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>),
	});

	return { lines, logger };
}

/** Asserts what Pino writes for the example's logger at each level, and where event data goes. */
function exerciseSink(): void {
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
}

/**
 * Sends one request that creates a project through the real application, then prints what the
 * response carried. Pino writes the application's events to the same stdout.
 */
async function serve(): Promise<void> {
	const { createTestApp } = await import("../.routa/testing.gen.js");
	const app = await createTestApp();
	const signature = createHmac("sha256", sessionSecret).update("acme:writer").digest("base64url");

	try {
		const response = await app.request("/tenants/acme/projects", {
			method: "POST",
			headers: {
				cookie: `session=demo-user:acme:writer.${signature}`,
				"content-type": "application/json",
				"x-request-id": "spoofed",
				"x-correlation-id": "checkout-42",
			},
			body: JSON.stringify({ name: "Atlas" }),
		});
		const served: Served = {
			exercise: {
				status: response.status,
				requestId: response.headers.get("x-request-id"),
				correlationId: response.headers.get("x-correlation-id"),
			},
		};
		process.stdout.write(`${JSON.stringify(served)}\n`);
	} finally {
		await app.dispose();
	}
}

/**
 * Runs the real application in a child process and asserts the events Pino wrote for its
 * startup and one request: the shared logger's without request identity, and the request
 * logger's, passed explicitly to a service, with it.
 */
function exerciseApplication(): void {
	const child = spawnSync(
		process.execPath,
		[...process.execArgv, fileURLToPath(import.meta.url), "serve"],
		{
			encoding: "utf8",
			env: {
				...process.env,
				NODE_ENV: "production",
				LOG_LEVEL: "info",
				ROUTA_DEMO_SESSION_SECRET: sessionSecret,
				ROUTA_DEMO_LOGGER: "",
			},
		},
	);
	assert.equal(child.status, 0, child.stderr);

	const lines = child.stdout
		.split("\n")
		.filter((line) => line.trim() !== "")
		.map((line) => JSON.parse(line) as Record<string, unknown>);
	const served = lines.find((line): line is Served => "exercise" in line)?.exercise;
	const written = lines.filter((line) => line.name === "full-api");
	const find = (event: string) => written.find((line) => line.event === event);

	assert.ok(served, "the child reports the response");
	assert.equal(served.status, 201);
	assert.match(served.requestId ?? "", /^[0-9a-f-]{36}$/);
	assert.notEqual(served.requestId, "spoofed", "Routa generates x-request-id");
	assert.equal(served.correlationId, "checkout-42");

	const catalog = find("projects.catalog_ready");
	assert.ok(catalog, "the real catalog's shared-logger event reaches Pino");
	assert.equal(catalog.level, 30);
	assert.deepEqual(
		catalog.data,
		{ service: "projects", store: "demo" },
		"the shared logger carries its own binding and no request identity",
	);

	const created = find("projects.created");
	assert.ok(created, "the real route's ctx.logger event reaches Pino");
	assert.deepEqual(
		created.data,
		{ requestId: served.requestId, correlationId: "checkout-42", projectId: "project_new" },
		"the service given ctx.logger logs with the request's identity",
	);

	const prepared = find("http.response.prepared");
	assert.ok(prepared, "Routa's request event reaches Pino");
	assert.deepEqual(prepared.data, {
		requestId: served.requestId,
		correlationId: "checkout-42",
		method: "POST",
		route: "/tenants/:tenantId/projects",
		status: 201,
		durationMs: (prepared.data as { durationMs: number }).durationMs,
	});
	assert.doesNotMatch(child.stdout, /spoofed|demo-user/, "no spoofed ID or credential is logged");

	console.log(
		`Pino wrote the real application's events: ${JSON.stringify({ catalog: catalog.data, created: created.data })}`,
	);
}
