import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createRoute } from "./index.js";
import { createHonoApp } from "./hono.js";

describe("createHonoApp", () => {
	it("runs route contracts through Hono and maps response status", async () => {
		const app = createHonoApp([
			{
				method: "get",
				path: "/users/:id",
				contract: createRoute({
					input: {
						params: z.object({ id: z.string() }),
						query: z.object({ includePosts: z.string().optional() }),
					},
					responses: {
						success: {
							status: 200,
							schema: z.object({ id: z.string(), includePosts: z.boolean() }),
						},
					},
					run: async ({ input }) => ({
						type: "success",
						data: {
							id: input.params.id,
							includePosts: input.query.includePosts === "true",
						},
					}),
				}),
			},
		]);

		const response = await app.request("/users/123?includePosts=true");

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ id: "123", includePosts: true });
	});

	it("returns problem details for validation failures", async () => {
		const app = createHonoApp([
			{
				method: "post",
				path: "/users",
				contract: createRoute({
					input: {
						body: z.object({ name: z.string() }),
					},
					responses: {
						success: {
							status: 201,
							schema: z.object({ id: z.string() }),
						},
					},
					run: async () => ({ type: "success", data: { id: "user_1" } }),
				}),
			},
		]);

		const response = await app.request("/users", {
			method: "POST",
			body: JSON.stringify({ name: 1 }),
			headers: { "content-type": "application/json" },
		});

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toMatchObject({
			title: "Validation failed",
			status: 400,
		});
	});

	it("rejects unsupported request body media types", async () => {
		const app = createHonoApp([
			{
				method: "post",
				path: "/users",
				contract: createRoute({
					input: {
						body: z.object({ name: z.string() }),
					},
					responses: {
						success: {
							status: 201,
							schema: z.object({ id: z.string() }),
						},
					},
					run: async () => ({ type: "success", data: { id: "user_1" } }),
				}),
			},
		]);

		const response = await app.request("/users", {
			method: "POST",
			body: "name=Jane",
			headers: { "content-type": "application/x-www-form-urlencoded" },
		});

		expect(response.status).toBe(415);
	});

	it("rejects unsupported response accept headers", async () => {
		const app = createHonoApp([
			{
				method: "get",
				path: "/status",
				contract: createRoute({
					responses: {
						success: {
							status: 200,
							schema: z.object({ ok: z.boolean() }),
						},
					},
					run: async () => ({ type: "success", data: { ok: true } }),
				}),
			},
		]);

		const response = await app.request("/status", {
			headers: { accept: "text/html" },
		});

		expect(response.status).toBe(406);
	});

	it("returns 405 for unsupported methods on known paths", async () => {
		const app = createHonoApp([
			{
				method: "get",
				path: "/status",
				contract: createRoute({
					responses: {
						success: {
							status: 200,
							schema: z.object({ ok: z.boolean() }),
						},
					},
					run: async () => ({ type: "success", data: { ok: true } }),
				}),
			},
		]);

		const response = await app.request("/status", { method: "POST" });

		expect(response.status).toBe(405);
		expect(response.headers.get("allow")).toBe("GET");
	});

	it("rejects GET route contracts with request bodies", () => {
		expect(() =>
			createHonoApp([
				{
					method: "get",
					path: "/users",
					contract: createRoute({
						input: {
							body: z.object({ name: z.string() }),
						},
						responses: {
							success: {
								status: 200,
								schema: z.object({ ok: z.boolean() }),
							},
						},
						run: async () => ({ type: "success", data: { ok: true } }),
					}),
				},
			]),
		).toThrow("cannot declare a request body");
	});
});
