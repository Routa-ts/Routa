import { createLogger, createRoute, type RoutaLogEvent, type RoutaLogger } from "@routa-ts/core";
import { createApplication, type HonoRoute } from "@routa-ts/core/hono";
import { expect, it } from "vitest";
import { z } from "zod";

const events: RoutaLogEvent[] = [];
const shared = createLogger({ redact: ["user.email"], sink: (event) => void events.push(event) });

/** An application service that logs through whichever logger its caller passes. */
function lookUp(logger: RoutaLogger) {
	logger.child({ component: "lookup" }).info("lookup.run", "Looked up.", {
		password: "hunter2",
		user: { email: "ada@example.com" },
	});
}

const who: HonoRoute = {
	method: "get",
	path: "/who",
	contract: createRoute({
		responses: { ok: { status: 200, schema: z.object({ requestId: z.string() }) } },
		run: ({ ctx }) => {
			lookUp(ctx.logger);
			lookUp(shared);
			return { type: "ok", data: { requestId: ctx.requestId } };
		},
	}),
};

it("binds request identity to redacted sink events and keeps it without a logger", async () => {
	const app = await createApplication([who], { logger: shared, correlation: true });
	const response = await app.fetch(
		new Request("http://localhost/who", { headers: { "x-correlation-id": "trace-1" } }),
	);
	const requestId = response.headers.get("x-request-id");
	await app.dispose();

	expect(response.headers.get("x-correlation-id")).toBe("trace-1");
	expect(await response.json()).toEqual({ requestId });
	const lookups = events.filter((event) => event.event === "lookup.run");
	expect(lookups.map((event) => event.data)).toEqual([
		{
			requestId,
			correlationId: "trace-1",
			component: "lookup",
			password: "[Redacted]",
			user: { email: "[Redacted]" },
		},
		{ component: "lookup", password: "[Redacted]", user: { email: "[Redacted]" } },
	]);
	expect(events.find((event) => event.event === "http.response.prepared")?.data).toMatchObject({
		requestId,
		correlationId: "trace-1",
		route: "/who",
		status: 200,
	});

	const quiet = await createApplication([who]);
	const off = await quiet.fetch(new Request("http://localhost/who"));
	await quiet.dispose();
	expect(await off.json()).toEqual({ requestId: off.headers.get("x-request-id") });
	expect(off.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
});
