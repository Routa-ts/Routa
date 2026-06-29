import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createHonoApp } from "./hono.js";
import { createMiddleware, createRoute } from "./index.js";
import { createLogger, type RoutaLogEvent } from "./logger.js";
import { requireAuth } from "./middleware/auth.js";

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

	it("runs middleware and accumulates context for the handler", async () => {
		const requireAuth = createMiddleware({
			provides: {
				user: z.object({ id: z.string() }),
			},
			run: ({ next }) => next({ user: { id: "user_1" } }),
		});
		const app = createHonoApp([
			{
				method: "get",
				path: "/me",
				contract: createRoute({
					middleware: [requireAuth],
					responses: {
						success: {
							status: 200,
							schema: z.object({ id: z.string() }),
						},
					},
					run: ({ ctx }) => ({
						type: "success",
						data: { id: ctx.user.id },
					}),
				}),
			},
		]);

		const response = await app.request("/me");

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ id: "user_1" });
	});

	it("stops the request when middleware returns a rejection response", async () => {
		const requireAuth = createMiddleware({
			rejects: ["unauthorized"],
			run: () => ({ type: "unauthorized", data: { message: "No token" } }),
		});
		const app = createHonoApp([
			{
				method: "get",
				path: "/me",
				contract: createRoute({
					middleware: [requireAuth],
					responses: {
						success: {
							status: 200,
							schema: z.object({ id: z.string() }),
						},
						unauthorized: {
							status: 401,
							schema: z.object({ message: z.string() }),
						},
					},
					run: () => ({ type: "success", data: { id: "user_1" } }),
				}),
			},
		]);

		const response = await app.request("/me");

		expect(response.status).toBe(401);
		await expect(response.json()).resolves.toEqual({ message: "No token" });
	});

	it("returns problem details for unknown handler response types", async () => {
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
					run: () => ({ type: "missing", data: { ok: true } }) as never,
				}),
			},
		]);

		const response = await app.request("/status");

		expect(response.status).toBe(500);
		await expect(response.json()).resolves.toMatchObject({
			title: "Invalid handler output",
			status: 500,
		});
	});

	it("returns problem details when handler response data fails its schema", async () => {
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
					run: () => ({ type: "success", data: { ok: "yes" } }) as never,
				}),
			},
		]);

		const response = await app.request("/status");

		expect(response.status).toBe(500);
		await expect(response.json()).resolves.toMatchObject({
			title: "Invalid handler output",
			status: 500,
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

	it("rejects invalid request body media type tokens", async () => {
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
			body: JSON.stringify({ name: "Jane" }),
			headers: { "content-type": "text/application/json" },
		});

		expect(response.status).toBe(415);
	});

	it("returns problem details for malformed JSON request bodies", async () => {
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
			body: "{",
			headers: { "content-type": "application/json" },
		});

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toMatchObject({
			title: "Invalid JSON body",
			status: 400,
		});
	});

	it("reuses parsed request bodies for middleware and route input", async () => {
		const requireTenant = createMiddleware({
			input: {
				body: z.object({ tenantId: z.string() }),
			},
			provides: {
				tenant: z.string(),
			},
			run: ({ input, next }) => next({ tenant: input.body.tenantId }),
		});
		const app = createHonoApp([
			{
				method: "post",
				path: "/users",
				contract: createRoute({
					middleware: [requireTenant],
					input: {
						body: z.object({ tenantId: z.string(), name: z.string() }),
					},
					responses: {
						success: {
							status: 201,
							schema: z.object({ tenantId: z.string(), name: z.string() }),
						},
					},
					run: ({ input, ctx }) => ({
						type: "success",
						data: { tenantId: ctx.tenant as string, name: input.body.name },
					}),
				}),
			},
		]);

		const response = await app.request("/users", {
			method: "POST",
			body: JSON.stringify({ tenantId: "tenant_1", name: "Jane" }),
			headers: { "content-type": "application/json" },
		});

		expect(response.status).toBe(201);
		await expect(response.json()).resolves.toEqual({ tenantId: "tenant_1", name: "Jane" });
	});

	it("parses cookie input for middleware", async () => {
		const withSession = createMiddleware({
			input: {
				cookies: z.object({ session: z.string().optional() }),
			},
			provides: {
				session: z.object({ authenticated: z.boolean(), userId: z.string().optional() }),
			},
			run: ({ input, next }) =>
				next({
					session: input.cookies.session
						? { authenticated: true, userId: input.cookies.session }
						: { authenticated: false },
				}),
		});
		const app = createHonoApp([
			{
				method: "get",
				path: "/session",
				contract: createRoute({
					middleware: [withSession],
					responses: {
						success: {
							status: 200,
							schema: z.object({ authenticated: z.boolean(), userId: z.string().optional() }),
						},
					},
					run: ({ ctx }) => ({ type: "success", data: ctx.session }),
				}),
			},
		]);

		const response = await app.request("/session", {
			headers: { cookie: "session=user_1" },
		});

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({
			authenticated: true,
			userId: "user_1",
		});
	});

	it("returns problem details for malformed cookies", async () => {
		const app = createHonoApp([
			{
				method: "get",
				path: "/session",
				contract: createRoute({
					input: {
						cookies: z.object({ session: z.string().optional() }),
					},
					responses: {
						success: {
							status: 200,
							schema: z.object({ ok: z.boolean() }),
						},
					},
					run: () => ({ type: "success", data: { ok: true } }),
				}),
			},
		]);

		const response = await app.request("/session", {
			headers: { cookie: "session=%E0%A4%A" },
		});

		expect(response.status).toBe(400);
		await expect(response.json()).resolves.toMatchObject({
			title: "Invalid Cookie",
			status: 400,
		});
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

	it("rejects json accept headers with zero quality", async () => {
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
			headers: { accept: "application/json;q=0" },
		});

		expect(response.status).toBe(406);
	});

	it("enforces requireAuth middleware at runtime", async () => {
		const withSession = createMiddleware({
			provides: {
				session: z.object({ authenticated: z.boolean(), userId: z.string().optional() }),
			},
			run: ({ next }) => next({ session: { authenticated: false } }),
		});
		const app = createHonoApp([
			{
				method: "get",
				path: "/me",
				contract: createRoute({
					middleware: [withSession, requireAuth()],
					responses: {
						success: {
							status: 200,
							schema: z.object({ id: z.string() }),
						},
						unauthorized: {
							status: 401,
							schema: z.object({ message: z.string() }),
						},
					},
					run: ({ ctx }) => ({ type: "success", data: { id: ctx.auth.userId } }),
				}),
			},
		]);

		const response = await app.request("/me");

		expect(response.status).toBe(401);
		await expect(response.json()).resolves.toEqual({ message: "Authentication required" });
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

	it("logs request completion when a logger is configured", async () => {
		const events: RoutaLogEvent[] = [];
		const app = createHonoApp(
			[
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
						run: () => ({ type: "success", data: { ok: true } }),
					}),
				},
			],
			{
				logger: createLogger({
					sink: (event) => events.push(event),
				}),
			},
		);

		const response = await app.request("/status");

		expect(response.status).toBe(200);
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({
			level: "info",
			event: "http.request",
			message: "Request completed.",
			data: {
				method: "GET",
				path: "/status",
				status: 200,
			},
		});
		expect(events[0]?.data?.durationMs).toEqual(expect.any(Number));
	});

	it("logs caught internal request errors", async () => {
		const events: RoutaLogEvent[] = [];
		const app = createHonoApp(
			[
				{
					method: "get",
					path: "/boom",
					contract: createRoute({
						responses: {
							success: {
								status: 200,
								schema: z.object({ ok: z.boolean() }),
							},
						},
						run: () => {
							throw new Error("boom");
						},
					}),
				},
			],
			{
				logger: createLogger({
					sink: (event) => events.push(event),
				}),
			},
		);

		const response = await app.request("/boom");

		expect(response.status).toBe(500);
		expect(events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					level: "error",
					event: "http.error",
					message: "Request failed.",
					data: expect.objectContaining({
						method: "GET",
						path: "/boom",
						status: 500,
						error: "boom",
					}),
				}),
			]),
		);
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
