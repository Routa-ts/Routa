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
			run: ({ input, ctx, response }) => {
				events.push("handler");
				return response.success({ user: ctx.user, include: input.query.include });
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

	it.each([true, false])(
		"selects declared statuses and bodies with validation=%s",
		async (validateResponses) => {
			const contract = createRoute({
				input: { query: z.object({ found: z.string() }) },
				responses: {
					ok: { status: 201, schema: z.object({ id: z.string() }) },
					notFound: { status: 404, schema: z.object({ message: z.string() }) },
				},
				run: async ({ input, response }) => {
					expect(Object.keys(response)).toEqual(["ok", "notFound"]);
					expect(Object.isFrozen(response)).toBe(true);
					// Constructing a result does not send it or commit its status.
					response.notFound({ message: "discarded" });
					return input.query.found === "yes"
						? response.ok(await Promise.resolve({ id: "1" }))
						: response.notFound({ message: "missing" });
				},
			});
			const execute = createRequestExecutor(contract as RuntimeRouteContract, {
				...executionOptions,
				validateResponses,
			});
			const found = await execute(new Request("http://local/users?found=yes"), {});
			expect(found.status).toBe(201);
			await expect(found.json()).resolves.toEqual({ id: "1" });
			const missing = await execute(new Request("http://local/users?found=no"), {});
			expect(missing.status).toBe(404);
			await expect(missing.json()).resolves.toEqual({ message: "missing" });
		},
	);

	it("validates builder payloads at runtime", async () => {
		const contract = createRoute({
			responses: { ok: { status: 200, schema: z.object({ id: z.string() }) } },
			run: ({ response }) => response.ok({ id: 42 } as never),
		});
		const execute = createRequestExecutor(contract as RuntimeRouteContract, executionOptions);
		const response = await execute(new Request("http://local/users"), {});
		expect(response.status).toBe(500);
		await expect(response.json()).resolves.toMatchObject({ title: "Invalid handler output" });
	});

	it.each(["__proto__", "constructor", "toString"])(
		"supports an outcome named %s",
		async (name) => {
			const contract = createRoute({
				responses: { [name]: { status: 200, schema: z.string() } },
				run: ({ response }) => {
					const build = response[name];
					if (!build) throw new Error("Missing response builder");
					return build("value");
				},
			});
			const execute = createRequestExecutor(contract as RuntimeRouteContract, executionOptions);
			const response = await execute(new Request("http://local/status"), {});
			expect(response.status).toBe(200);
			await expect(response.json()).resolves.toBe("value");
		},
	);

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
