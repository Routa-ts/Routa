import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createHonoApp } from "./hono.js";
import { createMiddleware, createRoute } from "./index.js";
import { createLogger, type RoutaLogEvent } from "./logger.js";

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

	it("returns an empty body for bodyless statuses", async () => {
		const app = createHonoApp([
			{
				method: "delete",
				path: "/users/:id",
				contract: createRoute({
					input: {
						params: z.object({ id: z.string() }),
					},
					responses: {
						success: {
							status: 204,
							schema: z.null(),
						},
					},
					run: async () => ({ type: "success", data: null }),
				}),
			},
		]);

		const response = await app.request("/users/123", { method: "DELETE" });

		expect(response.status).toBe(204);
		expect(response.headers.get("content-type")).toBeNull();
		await expect(response.text()).resolves.toBe("");
	});

	it("prefers an explicit HEAD contract over Hono's GET fallback", async () => {
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
					run: () => ({ type: "success", data: { ok: true } }),
				}),
			},
			{
				method: "head",
				path: "/status",
				contract: createRoute({
					responses: {
						success: {
							status: 204,
							schema: z.null(),
						},
					},
					run: () => ({ type: "success", data: null }),
				}),
			},
		]);

		const headResponse = await app.request("/status", { method: "HEAD" });
		const getResponse = await app.request("/status");

		expect(headResponse.status).toBe(204);
		expect(getResponse.status).toBe(200);
		await expect(getResponse.json()).resolves.toEqual({ ok: true });
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
			rejects: {
				unauthorized: {
					status: 401,
					schema: z.object({ message: z.string() }),
				},
			},
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

	it("accepts application/*+json request body content types", async () => {
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
							schema: z.object({ id: z.string(), name: z.string() }),
						},
					},
					run: async ({ input }) => ({
						type: "success",
						data: { id: "user_1", name: input.body.name },
					}),
				}),
			},
		]);

		const response = await app.request("/users", {
			method: "POST",
			body: JSON.stringify({ name: "Jane" }),
			headers: { "content-type": "application/vnd.api+json" },
		});

		expect(response.status).toBe(201);
		await expect(response.json()).resolves.toEqual({ id: "user_1", name: "Jane" });
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

	it("decodes cookie values and keeps malformed percent-encoding raw", async () => {
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
							schema: z.object({ session: z.string().optional() }),
						},
					},
					run: ({ input }) => ({ type: "success", data: input.cookies }),
				}),
			},
		]);

		const decoded = await app.request("/session", {
			headers: { cookie: "session=hello%20world" },
		});
		expect(decoded.status).toBe(200);
		await expect(decoded.json()).resolves.toEqual({ session: "hello world" });

		const malformed = await app.request("/session", {
			headers: { cookie: "session=%E0%A4%A" },
		});
		expect(malformed.status).toBe(200);
		await expect(malformed.json()).resolves.toEqual({ session: "%E0%A4%A" });
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

	it("honors a more specific json rejection over accept wildcards", async () => {
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
			headers: { accept: "application/*;q=1, application/json;q=0" },
		});

		expect(response.status).toBe(406);
	});

	it("accepts application/*+json accept headers", async () => {
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
			headers: { accept: "application/problem+json" },
		});

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ ok: true });
	});

	it("honors a more specific +json rejection over accept wildcards", async () => {
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
			headers: { accept: "application/*;q=1, application/problem+json;q=0" },
		});

		expect(response.status).toBe(406);
	});

	it("rejects duplicate route registrations", () => {
		expect(() =>
			createHonoApp([
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
			]),
		).toThrow("Duplicate route registration: GET /status");
	});

	it("rejects duplicate middleware reject keys at construction", () => {
		const first = createMiddleware({
			rejects: {
				unauthorized: {
					status: 401,
					schema: z.object({ message: z.string() }),
				},
			},
			run: ({ next }) => next(),
		});
		const second = createMiddleware({
			rejects: {
				unauthorized: {
					status: 403,
					schema: z.object({ message: z.string() }),
				},
			},
			run: ({ next }) => next(),
		});

		expect(() =>
			createHonoApp([
				{
					method: "get",
					path: "/me",
					contract: createRoute({
						middleware: [first, second],
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
		).toThrow('Duplicate middleware reject key "unauthorized" on GET /me');
	});

	it("returns problem details when createContext returns a non-object", async () => {
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
				createContext: () => "not-an-object" as never,
			},
		]);

		const response = await app.request("/status");

		expect(response.status).toBe(500);
		await expect(response.json()).resolves.toMatchObject({
			title: "Invalid handler output",
			status: 500,
		});
	});

	it("returns problem details when createContext returns null", async () => {
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
						run: async () => ({ type: "success", data: { ok: true } }),
					}),
					createContext: () => null as never,
				},
			],
			{
				logger: createLogger({
					sink: (event) => events.push(event),
				}),
			},
		);

		const response = await app.request("/status");

		expect(response.status).toBe(500);
		await expect(response.json()).resolves.toMatchObject({
			title: "Invalid handler output",
			status: 500,
		});
		expect(events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					level: "error",
					data: expect.objectContaining({
						error: "createContext() must return a plain object, received null.",
					}),
				}),
			]),
		);
	});

	it("returns problem details when response JSON serialization fails", async () => {
		const app = createHonoApp([
			{
				method: "get",
				path: "/status",
				contract: createRoute({
					responses: {
						success: {
							status: 200,
							schema: z.any(),
						},
					},
					run: async () => ({ type: "success", data: { value: 1n } }),
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

	it("returns middleware reject when auth guard finds unauthenticated session", async () => {
		const withSession = createMiddleware({
			provides: {
				session: z.object({ authenticated: z.boolean(), userId: z.string().optional() }),
			},
			run: ({ next }) => next({ session: { authenticated: false } }),
		});
		const requireAuth = createMiddleware({
			requires: ["session"],
			provides: {
				auth: z.object({ userId: z.string() }),
			},
			rejects: {
				unauthorized: {
					status: 401,
					schema: z.object({ message: z.string() }),
				},
			},
			run: ({ ctx, next }) => {
				const session = ctx.session as
					| { authenticated?: boolean; userId?: string }
					| null
					| undefined;

				if (!session?.authenticated || !session.userId) {
					return { type: "unauthorized", data: { message: "Authentication required" } };
				}

				return next({ auth: { userId: session.userId } });
			},
		});
		const app = createHonoApp([
			{
				method: "get",
				path: "/me",
				contract: createRoute({
					middleware: [withSession, requireAuth],
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

	it("returns middleware reject when auth guard session is null", async () => {
		const withNullSession = createMiddleware({
			provides: {
				session: z.unknown(),
			},
			run: ({ next }) => next({ session: null }),
		});
		const requireAuth = createMiddleware({
			requires: ["session"],
			provides: {
				auth: z.object({ userId: z.string() }),
			},
			rejects: {
				unauthorized: {
					status: 401,
					schema: z.object({ message: z.string() }),
				},
			},
			run: ({ ctx, next }) => {
				const session = ctx.session as
					| { authenticated?: boolean; userId?: string }
					| null
					| undefined;

				if (!session?.authenticated || !session.userId) {
					return { type: "unauthorized", data: { message: "Authentication required" } };
				}

				return next({ auth: { userId: session.userId } });
			},
		});
		const app = createHonoApp([
			{
				method: "get",
				path: "/me",
				contract: createRoute({
					middleware: [withNullSession, requireAuth],
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

	it("rejects requests when middleware required context is missing", async () => {
		const events: RoutaLogEvent[] = [];
		const needsUser = createMiddleware({
			requires: ["user"],
			run: ({ next }) => next(),
		});
		const app = createHonoApp(
			[
				{
					method: "get",
					path: "/secure",
					contract: createRoute({
						middleware: [needsUser],
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

		const response = await app.request("/secure");

		expect(response.status).toBe(500);
		await expect(response.json()).resolves.toMatchObject({
			title: "Internal Server Error",
			status: 500,
		});
		expect(events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					level: "error",
					data: expect.objectContaining({
						error: "Middleware requires ctx.user, but it was not provided.",
					}),
				}),
			]),
		);
	});

	it("rejects middleware provides that fail schema validation", async () => {
		const badProvides = createMiddleware({
			provides: {
				user: z.object({ id: z.string() }),
			},
			run: ({ next }) => next({ user: { id: 123 } }),
		});
		const app = createHonoApp([
			{
				method: "get",
				path: "/me",
				contract: createRoute({
					middleware: [badProvides],
					responses: {
						success: {
							status: 200,
							schema: z.object({ id: z.string() }),
						},
					},
					run: ({ ctx }) => ({ type: "success", data: { id: ctx.user.id } }),
				}),
			},
		]);

		const response = await app.request("/me");

		expect(response.status).toBe(500);
		await expect(response.json()).resolves.toMatchObject({
			title: "Invalid handler output",
			status: 500,
		});
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
		expect(response.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
	});

	it("generates OPTIONS from declared methods", async () => {
		const responseSchema = z.object({ ok: z.boolean() });
		const app = createHonoApp([
			{
				method: "get",
				path: "/status",
				contract: createRoute({
					responses: { success: { status: 200, schema: responseSchema } },
					run: () => ({ type: "success", data: { ok: true } }),
				}),
			},
			{
				method: "put",
				path: "/status",
				contract: createRoute({
					responses: { success: { status: 200, schema: responseSchema } },
					run: () => ({ type: "success", data: { ok: true } }),
				}),
			},
		]);

		const response = await app.request("/status", { method: "OPTIONS" });

		expect(response.status).toBe(204);
		expect(response.headers.get("allow")).toBe("GET, HEAD, OPTIONS, PUT");
		expect(response.headers.get("access-control-allow-methods")).toBeNull();
		await expect(response.text()).resolves.toBe("");
	});

	it("advertises derived methods for CORS preflight without granting an origin", async () => {
		const app = createHonoApp([
			{
				method: "post",
				path: "/users",
				contract: createRoute({
					responses: {
						success: { status: 201, schema: z.object({ id: z.string() }) },
					},
					run: () => ({ type: "success", data: { id: "user_1" } }),
				}),
			},
		]);

		const response = await app.request("/users", {
			method: "OPTIONS",
			headers: {
				origin: "https://app.example.com",
				"access-control-request-method": "POST",
				"access-control-request-headers": "content-type",
			},
		});

		expect(response.status).toBe(204);
		expect(response.headers.get("allow")).toBe("OPTIONS, POST");
		expect(response.headers.get("access-control-allow-methods")).toBe("OPTIONS, POST");
		expect(response.headers.get("access-control-allow-origin")).toBeNull();
		expect(response.headers.get("vary")).toBe(
			"Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
		);
	});

	it("rejects manually declared OPTIONS routes at runtime", () => {
		expect(() =>
			createHonoApp([
				{
					method: "options" as never,
					path: "/status",
					contract: createRoute({
						responses: { success: { status: 204, schema: z.null() } },
						run: () => ({ type: "success", data: null }),
					}),
				},
			]),
		).toThrow("OPTIONS /status cannot be declared explicitly");
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

	it("provides the configured logger to route handlers", async () => {
		const events: RoutaLogEvent[] = [];
		let handlerLogger: unknown;
		const logger = createLogger({
			sink: (event) => events.push(event),
		});
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
						run: ({ ctx }) => {
							handlerLogger = ctx.logger;
							ctx.logger.info("status.checked", "Status checked from a handler.");
							return { type: "success", data: { ok: true } };
						},
					}),
					createContext: () => ({ logger: "cannot replace the runtime logger" }),
				},
			],
			{ logger },
		);

		const response = await app.request("/status");

		expect(response.status).toBe(200);
		expect(handlerLogger).toBe(logger);
		expect(events).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					level: "info",
					event: "status.checked",
					message: "Status checked from a handler.",
				}),
			]),
		);
	});

	it("provides a no-op logger to route handlers when logging is not configured", async () => {
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
					run: ({ ctx }) => {
						ctx.logger.info("status.checked", "This event is disabled.");
						return { type: "success", data: { ok: true } };
					},
				}),
			},
		]);

		const response = await app.request("/status");

		expect(response.status).toBe(200);
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

	it("rejects GET and HEAD route contracts with request bodies", () => {
		for (const method of ["get", "head"] as const) {
			expect(() =>
				createHonoApp([
					{
						method,
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
		}
	});
});
