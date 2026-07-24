import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createMiddleware, createRouta, createRoute, createRouteRoot } from "./index.js";
import type { RoutaLogger } from "./logger.js";

declare module "./index.js" {
	interface Register {
		routeCtxByPath: {
			"/logger-conflict": { get: { logger: string } };
			"/status": { get: Record<never, never> };
			"/users": { post: { user: { id: string } } };
		};
	}
}

describe("route contracts", () => {
	it("preserves route method declarations", () => {
		const requireAuth = createMiddleware({
			provides: {
				user: z.object({
					id: z.string(),
				}),
			},
		});

		const routeRoot = createRouteRoot("/users");
		const route = routeRoot({
			post: createRoute({
				input: {
					body: z.object({
						email: z.string().email(),
					}),
				},
				responses: {
					success: {
						status: 201,
						schema: z.object({
							id: z.string(),
						}),
					},
				},
				middleware: [requireAuth],
				run: ({ ctx }) => {
					expectType<string>(ctx.user.id);
					expectType<RoutaLogger>(ctx.logger);
					return { type: "success", data: { id: "usr_1" } };
				},
			}),
		});

		expect(route.post.responses.success.status).toBe(201);

		routeRoot({
			// @ts-expect-error OPTIONS is generated from the declared route methods.
			options: createRoute({
				responses: {
					success: { status: 204, schema: z.null() },
				},
				run: () => ({ type: "success", data: null }),
			}),
		});
	});

	it("preserves Routa app configuration", () => {
		const app = createRouta({
			port: 3001,
		});

		expect(app.port).toBe(3001);
	});

	it("keeps the framework logger authoritative in route context types", () => {
		const route = createRouteRoot("/logger-conflict");

		route({
			get: createRoute({
				responses: {
					success: { status: 200, schema: z.object({ ok: z.boolean() }) },
				},
				run: ({ ctx }) => {
					expectType<RoutaLogger>(ctx.logger);
					// @ts-expect-error Framework-owned logger replaces conflicting application context types.
					expectType<string>(ctx.logger);
					return { type: "success", data: { ok: true } };
				},
			}),
		});
	});

	it("typechecks local and external deprecation replacements", () => {
		const responses = {
			success: { status: 200, schema: z.object({ ok: z.boolean() }) },
		};

		createRoute({
			deprecation: { replacement: "/status" },
			responses,
			run: () => ({ type: "success", data: { ok: true } }),
		});
		createRoute({
			deprecation: { replacement: "https://api.example.com/v2/status" },
			responses,
			run: () => ({ type: "success", data: { ok: true } }),
		});
		createRoute({
			deprecation: {
				// @ts-expect-error Local replacements must be registered route paths.
				replacement: "/missing",
			},
			responses,
			run: () => ({ type: "success", data: { ok: true } }),
		});
		createRoute({
			deprecation: {
				// @ts-expect-error External replacements must be absolute HTTP(S) URLs.
				replacement: "api.example.com/v2/status",
			},
			responses,
			run: () => ({ type: "success", data: { ok: true } }),
		});
	});

	it("typechecks middleware rejection tags and data", () => {
		createMiddleware({
			rejects: {
				unauthorized: {
					status: 401,
					schema: z.object({ message: z.string() }),
				},
			},
			run: () => ({
				type: "unauthorized",
				data: { message: "No token" },
			}),
		});

		createMiddleware({
			rejects: {
				unauthorized: {
					status: 401,
					schema: z.object({ message: z.string() }),
				},
			},
			run: () => ({
				// @ts-expect-error Middleware may only return declared reject types.
				type: "notDeclared",
				data: { message: "No token" },
			}),
		});

		createMiddleware({
			rejects: {
				unauthorized: {
					status: 401,
					schema: z.object({ message: z.string() }),
				},
			},
			run: () => ({
				type: "unauthorized",
				// @ts-expect-error Reject data must match the selected reject schema.
				data: { message: 401 },
			}),
		});
	});
});

function expectType<T>(_value: T): void {}
