import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { createHonoApp, type HonoRoute } from "./hono.js";
import {
	type AnyMiddlewareContract,
	createCookie,
	createMiddleware,
	createRoute,
} from "./index.js";
import { createLogger, type RoutaLogEvent } from "./logger.js";

const session = createCookie({
	name: "session",
	schema: z.string(),
	httpOnly: true,
	secure: true,
	sameSite: "lax",
	path: "/",
});

/** Type fixtures: compiled, never run, so invalid declarations do not throw. */
function typesOnly(_check: () => void): void {}

function serve(route: HonoRoute, events: RoutaLogEvent[] = []) {
	return createHonoApp([route], {
		logger: createLogger({ sink: (event) => events.push(event) }),
	});
}

describe("continuing middleware (types)", () => {
	it("hands middleware an opaque next() result it can only return unchanged", () => {
		typesOnly(() => {
			createMiddleware({
				run: ({ next }) => next(),
			});

			createMiddleware({
				run: async ({ next }) => {
					const result = await next();
					return result;
				},
			});

			createMiddleware({
				// @ts-expect-error A continuing middleware cannot append response effects.
				run: async ({ next }) => {
					const result = await next();
					return { ...result, headers: { "x-extra": "1" } };
				},
			});

			createMiddleware({
				rejects: { denied: { status: 403 } },
				// @ts-expect-error A copy of next()'s result is not the selected outcome.
				run: async ({ next }) => {
					const result = await next();
					const copy = { ...result };
					return copy;
				},
			});

			createMiddleware({
				run: async ({ next }) => {
					const result = await next();
					// @ts-expect-error The selected outcome is opaque to middleware.
					void result.type;
					return result;
				},
			});
		});
	});
});

describe("continuing middleware (runtime)", () => {
	const route = (middleware: AnyMiddlewareContract): HonoRoute => ({
		method: "get",
		path: "/a",
		contract: createRoute({
			middleware: [middleware],
			responses: {
				ok: {
					status: 200,
					schema: z.object({ ok: z.boolean() }),
					headers: z.object({ etag: z.string().optional() }),
					cookies: [session],
				},
			},
			run: () => ({ type: "ok", data: { ok: true } }),
		}),
	});

	it("sends the selected outcome when the middleware returns next() unchanged", async () => {
		const passThrough = createMiddleware({
			run: async ({ next }) => {
				const result = await next();
				return result;
			},
		});
		const response = await serve(route(passThrough)).request("/a");

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toEqual({ ok: true });
	});

	it("fails a middleware that changes or appends to the selected outcome after next()", async () => {
		const appended = [
			(result: object) => ({ ...result, headers: { etag: '"1"' } }),
			(result: object) => ({ ...result, cookies: [session.set("stolen")] }),
			(result: object) => ({ ...result }),
			(result: object) => Object.assign(result, { headers: { etag: '"1"' } }),
		];

		for (const change of appended) {
			const events: RoutaLogEvent[] = [];
			const response = await serve(
				route(
					createMiddleware({
						run: (async ({ next }: { next: () => Promise<object> }) =>
							change(await next())) as never,
					}),
				),
				events,
			).request("/a");

			expect(response.status, change.toString()).toBe(500);
			expect(response.headers.get("etag")).toBeNull();
			expect(response.headers.getSetCookie()).toEqual([]);
			// next() resolves to a frozen token, so even an in-place change cannot reach the outcome.
			expect(JSON.stringify(events)).toMatch(/next\(\)|not extensible/);
		}
	});

	it("fails a middleware that returns its own reject after next()", async () => {
		const late = createMiddleware({
			rejects: { denied: { status: 403 } },
			run: async ({ next }) => {
				await next();
				return { type: "denied" };
			},
		});
		const response = await serve(route(late)).request("/a");

		expect(response.status).toBe(500);
	});
});

describe("outcome producers", () => {
	const guard = createMiddleware({
		rejects: { unauthorized: { status: 401, schema: z.object({ message: z.string() }) } },
		run: ({ next }) => next(),
	});
	const audit = createMiddleware({
		rejects: { rateLimited: { status: 429 } },
		run: (() => ({ type: "unauthorized", data: { message: "no" } })) as never,
	});

	it("only accepts each producer's own outcomes", async () => {
		const handlerReturnsReject = await serve({
			method: "get",
			path: "/a",
			contract: createRoute({
				middleware: [guard],
				responses: { ok: { status: 200 } },
				run: (() => ({ type: "unauthorized", data: { message: "no" } })) as never,
			}),
		}).request("/a");
		const middlewareReturnsOthersReject = await serve({
			method: "get",
			path: "/a",
			contract: createRoute({
				middleware: [guard, audit],
				responses: { ok: { status: 200 } },
				run: () => ({ type: "ok" }),
			}),
		}).request("/a");

		expect(handlerReturnsReject.status).toBe(500);
		expect(middlewareReturnsOthersReject.status).toBe(500);
	});
});

describe("terminal middleware reject declarations at registration", () => {
	const register =
		(method: "get" | "head", rejects: Record<string, unknown>, responses = {}) =>
		() =>
			createHonoApp([
				{
					method,
					path: "/a",
					contract: createRoute({
						middleware: [{ rejects: rejects as never, run: ({ next }) => next() }],
						responses: { ok: { status: 200 }, ...responses },
						run: () => ({ type: "ok" }),
					}),
				},
			]);

	it("rejects a body reject on a HEAD route", () => {
		const body = { denied: { status: 403, schema: z.object({ message: z.string() }) } };

		expect(register("get", body)).not.toThrow();
		expect(register("head", body)).toThrow(/Middleware reject "denied" on HEAD \/a .*HEAD/);
		expect(register("head", { denied: { status: 403 } })).not.toThrow();
	});

	it("rejects an outcome name the route and a middleware both declare", () => {
		expect(register("get", { ok: { status: 401 } })).toThrow(
			/Outcome "ok" on GET \/a is declared by the route and by middleware\[0\]/,
		);
	});
});
