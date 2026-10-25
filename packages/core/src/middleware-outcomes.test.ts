import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { createHonoApp, type HonoRoute } from "./hono.js";
import {
	type AnyMiddlewareContract,
	type CookieEffect,
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

describe("outcome names (types)", () => {
	it("fails a route outcome named like a reject of the route's own middleware", () => {
		const guard = createMiddleware({
			rejects: { unauthorized: { status: 401 } },
			run: ({ next }) => next(),
		});

		typesOnly(() => {
			createRoute({
				middleware: [guard],
				responses: { ok: { status: 200 }, notFound: { status: 404 } },
				run: () => ({ type: "ok" }),
			});

			createRoute({
				middleware: [guard],
				responses: {
					ok: { status: 200 },
					// @ts-expect-error The handler result names its outcome, so names must be distinct.
					unauthorized: { status: 401 },
				},
				run: () => ({ type: "ok" }),
			});

			createRoute({
				responses: { ok: { status: 200 }, unauthorized: { status: 401 } },
				run: () => ({ type: "ok" }),
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

describe("selection boundary", () => {
	const modes: Array<Parameters<typeof createHonoApp>[1]> = [
		{ runtimeMode: "dev" },
		{ runtimeMode: "start" },
		{ runtimeMode: "start", responseValidation: "always" },
	];
	const theme = createCookie({
		name: "theme",
		schema: z.string(),
		httpOnly: false,
		secure: true,
		sameSite: "lax",
		path: "/",
	});
	const outcome = {
		schema: z.object({ message: z.string() }),
		headers: z.object({ etag: z.string() }),
		cookies: [theme, session],
	};

	/** Shared objects a producer returns and a middleware later changes in place. */
	function shared() {
		const data = { message: "selected" };
		const headers = { etag: '"1"' };
		const cookies: Array<CookieEffect<typeof theme> | CookieEffect<typeof session>> = [
			theme.set("dark"),
		];

		return {
			result: { data, headers, cookies },
			mutate: () => {
				data.message = "late";
				headers.etag = '"late"';
				cookies[0] = theme.set("light");
				cookies.push(session.set("late"));
			},
		};
	}

	/** A middleware that continues, then changes the selected result's objects in place. */
	const lateWriter = (mutate: () => void) =>
		createMiddleware({
			run: async ({ next }) => {
				const result = await next();
				mutate();
				return result;
			},
		});

	const producers = {
		"route outcome": (): { route: HonoRoute; status: number } => {
			const { result, mutate } = shared();

			return {
				status: 200,
				route: {
					method: "get",
					path: "/a",
					contract: createRoute({
						middleware: [lateWriter(mutate)],
						responses: { ok: { status: 200, ...outcome } },
						run: () => ({ type: "ok" as const, ...result }),
					}),
				},
			};
		},
		"middleware reject": (): { route: HonoRoute; status: number } => {
			const { result, mutate } = shared();

			return {
				status: 403,
				route: {
					method: "get",
					path: "/a",
					contract: createRoute({
						middleware: [
							lateWriter(mutate),
							createMiddleware({
								rejects: { denied: { status: 403, ...outcome } },
								run: () => ({ type: "denied" as const, ...result }),
							}),
						],
						responses: { ok: { status: 200 } },
						run: () => ({ type: "ok" }),
					}),
				},
			};
		},
	};

	for (const [producer, build] of Object.entries(producers)) {
		it(`sends the ${producer} as selected when middleware later changes its objects`, async () => {
			for (const options of modes) {
				const { route, status } = build();
				const response = await createHonoApp([route], options).request("/a");
				const mode = JSON.stringify(options);

				expect(response.status, mode).toBe(status);
				await expect(response.json(), mode).resolves.toEqual({ message: "selected" });
				expect(response.headers.get("etag"), mode).toBe('"1"');
				expect(
					response.headers.getSetCookie().map((field) => field.split(";")[0]),
					mode,
				).toEqual(["theme=dark"]);
			}
		});
	}
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

describe("response validation policy across route outcomes and middleware rejects", () => {
	type Mode = { name: string; options: Parameters<typeof createHonoApp>[1]; parses: boolean };

	const modes: Mode[] = [
		{ name: "development", options: { runtimeMode: "dev" }, parses: true },
		{ name: "production by default", options: { runtimeMode: "start" }, parses: false },
		{
			name: "production with always",
			options: { runtimeMode: "start", responseValidation: "always" },
			parses: true,
		},
	];
	const outcome = {
		status: 403,
		schema: z.object({ message: z.string().trim(), code: z.enum(["denied"]) }),
		headers: z.object({ "x-reason": z.string().toLowerCase().optional() }),
		cookies: [createCookie({ ...session, name: "flag", schema: z.string().trim() })],
	} as const;
	const [flag] = outcome.cookies;
	const valid = { data: { message: "No", code: "denied" } };

	/** Each case is a result for `outcome`, and whether only Zod parsing can find the problem. */
	const cases: Array<{ name: string; result: Record<string, unknown>; zodOnly: boolean }> = [
		{ name: "a valid result", result: valid, zodOnly: false },
		{ name: "an invalid body", result: { data: { message: "No", code: "other" } }, zodOnly: true },
		{
			name: "a body the schema would change",
			result: { data: { message: " No ", code: "denied" } },
			zodOnly: true,
		},
		{
			name: "a header the schema would change",
			result: { ...valid, headers: { "x-reason": "LOUD" } },
			zodOnly: true,
		},
		{
			name: "a cookie the schema would change",
			result: { ...valid, cookies: [flag.set(" x ")] },
			zodOnly: true,
		},
		{
			name: "an undeclared header",
			result: { ...valid, headers: { "x-other": "1" } },
			zodOnly: false,
		},
		{
			name: "an unsafe header value",
			result: { ...valid, headers: { "x-reason": "a\nb" } },
			zodOnly: false,
		},
		{ name: "a missing body", result: {}, zodOnly: false },
		{
			name: "an undeclared cookie",
			result: { ...valid, cookies: [session.set("s")] },
			zodOnly: false,
		},
	];
	const producers = {
		"route outcome": (result: Record<string, unknown>): HonoRoute => ({
			method: "get",
			path: "/a",
			contract: createRoute({
				responses: { ok: { status: 200 }, denied: outcome },
				run: () => ({ type: "denied", ...result }) as never,
			}),
		}),
		"middleware reject": (result: Record<string, unknown>): HonoRoute => ({
			method: "get",
			path: "/a",
			contract: createRoute({
				middleware: [
					createMiddleware({
						rejects: { denied: outcome },
						run: () => ({ type: "denied", ...result }) as never,
					}),
				],
				responses: { ok: { status: 200 } },
				run: () => ({ type: "ok" }),
			}),
		}),
	};

	for (const [producer, routeFor] of Object.entries(producers)) {
		for (const mode of modes) {
			it(`applies the ${mode.name} policy to a ${producer}`, async () => {
				for (const { name, result, zodOnly } of cases) {
					const response = await createHonoApp([routeFor(result)], mode.options).request("/a");
					const fails = name !== "a valid result" && (!zodOnly || mode.parses);

					expect(response.status, name).toBe(fails ? 500 : 403);

					if (!fails) {
						// Routa sends the handler's values, never values Zod changed.
						await expect(response.json(), name).resolves.toEqual(result.data);
						expect(response.headers.get("x-reason"), name).toBe(
							(result.headers as Record<string, string> | undefined)?.["x-reason"] ?? null,
						);
						expect(
							response.headers.getSetCookie().map((field) => field.split(";")[0]),
							name,
						).toEqual(result.cookies ? ["flag=%20x%20"] : []);
					}
				}
			});
		}
	}
});
