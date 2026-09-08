import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createMiddleware, createRoute } from "./index.js";
import { createLogger } from "./logger.js";
import { createRequestExecutor, type RuntimeRouteContract } from "./request-execution.js";

const executionOptions = {
	logger: createLogger({ enabled: false }),
	validateResponses: true,
};

describe("createRequestExecutor", () => {
	it("executes middleware in order and passes parsed request data", async () => {
		const events: string[] = [];
		const addUser = createMiddleware({
			input: { params: z.object({ id: z.string() }) },
			provides: { user: z.string() },
			run: ({ input, next }) => {
				events.push("middleware:before");
				return next({ user: input.params.id });
			},
		});
		const contract = createRoute({
			middleware: [addUser],
			input: { query: z.object({ include: z.string() }) },
			responses: {
				success: { status: 200, schema: z.object({ user: z.string(), include: z.string() }) },
			},
			run: ({ input, ctx }) => {
				events.push("handler");
				return { type: "success", data: { user: ctx.user, include: input.query.include } };
			},
		});
		const execute = createRequestExecutor(contract as RuntimeRouteContract, executionOptions);

		const response = await execute(new Request("http://local/users?include=posts"), {
			id: "user_1",
		});

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ user: "user_1", include: "posts" });
		expect(events).toEqual(["middleware:before", "handler"]);
	});

	it("maps execution failures to problem responses", async () => {
		const contract = createRoute({
			responses: {
				success: { status: 200, schema: z.object({ ok: z.boolean() }) },
			},
			run: () => ({ type: "missing", data: {} }) as never,
		});
		const execute = createRequestExecutor(contract as RuntimeRouteContract, executionOptions);

		const response = await execute(new Request("http://local/status"), {});

		expect(response.status).toBe(500);
		await expect(response.json()).resolves.toMatchObject({
			title: "Invalid handler output",
			status: 500,
		});
	});
});
