import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import {
	type ApplicationServicesDeclaration,
	createApplication,
	createHonoApp,
	type HonoRoute,
	type RequestServicesDeclaration,
} from "./hono.js";
import {
	type AnyMiddlewareContract,
	createMiddleware,
	createRoute,
	createRouteRootFactory,
	defineServices,
} from "./index.js";
import { createLogger, type RoutaLogEvent } from "./logger.js";

type Ctx = Record<string, any>;

const appServices = (
	names: readonly string[],
	factory: () => object,
): ApplicationServicesDeclaration => ({ names, factory });

const scope = (
	names: readonly string[],
	after: number,
	factory: RequestServicesDeclaration["factory"],
): RequestServicesDeclaration => ({ names, after, factory });

/** A route whose handler returns what `run` reads from its context. */
const route = (
	options: {
		method?: HonoRoute["method"];
		middleware?: readonly AnyMiddlewareContract[];
		services?: HonoRoute["services"];
	},
	run: (ctx: Ctx) => unknown,
): HonoRoute => ({
	method: options.method ?? "get",
	path: "/orders",
	contract: createRoute({
		responses: { ok: { status: 200, schema: z.unknown() } },
		middleware: options.middleware ?? [],
		run: ({ ctx }) => ({ type: "ok", data: run(ctx as Ctx) ?? null }),
	}),
	...(options.services && { services: options.services }),
});

/** Middleware that provides `key` and records what it saw before and after `next()`. */
const observe = (key: string, seen: string[]) =>
	createMiddleware({
		provides: { [key]: z.string() },
		run: async ({ ctx, next }) => {
			const view = ctx as Ctx;
			seen.push(`${key} before: ${Object.keys(view.services ?? {}).join(",")}`);
			const result = await next({ [key]: key });
			seen.push(`${key} after: ${Object.keys(view.services ?? {}).join(",")}`);
			return result;
		},
	}) as AnyMiddlewareContract;

/** Middleware that continues the chain, running hooks around `next()`. */
const passThrough = (hooks: { before?: () => void; after?: () => void }) => {
	const middleware = createMiddleware({
		run: async ({ next }) => {
			hooks.before?.();
			const result = await next();
			hooks.after?.();
			return result;
		},
	});
	return middleware as AnyMiddlewareContract;
};

const request = (app: { fetch: (request: Request) => Promise<Response> }, method = "GET") =>
	app.fetch(new Request("http://localhost/orders", { method }));

describe("request-scoped services", () => {
	it("runs the route-file factory per request, after filesystem middleware, with earlier context", async () => {
		const seen: string[] = [];
		let constructed = 0;
		const app = await createApplication(
			[
				route(
					{
						middleware: [observe("fs", seen), observe("local", seen)],
						services: {
							routeFile: scope(["orders"], 1, ({ ctx }) => {
								const view = ctx as Ctx;
								seen.push(`factory: ${view.fs} ${Object.keys(view.services).join(",")}`);
								return { orders: { id: ++constructed, db: view.services.db } };
							}),
						},
					},
					(ctx) => ({
						names: Object.keys(ctx.services),
						id: ctx.services.orders.id,
						shared: ctx.services.orders.db === ctx.services.db,
					}),
				),
			],
			{ services: appServices(["db"], () => ({ db: {} })) },
		);

		expect(await (await request(app)).json()).toEqual({
			names: ["db", "orders"],
			id: 1,
			shared: true,
		});
		expect(await (await request(app)).json()).toMatchObject({ id: 2 });
		expect(seen.slice(0, 5)).toEqual([
			"fs before: db",
			"factory: fs db",
			"local before: db,orders",
			"local after: db,orders",
			"fs after: db",
		]);
		await app.dispose();
	});

	it("runs the method factory after route-file middleware, only for its own method", async () => {
		const ran: string[] = [];
		const routeFile = scope(["orders"], 0, () => {
			ran.push("route file");
			return { orders: "orders" };
		});
		const app = await createApplication([
			route(
				{
					middleware: [observe("local", [])],
					services: {
						routeFile,
						method: scope(["checkout"], 1, ({ ctx }) => {
							const view = ctx as Ctx;
							ran.push(`get method: ${view.local} ${Object.keys(view.services).join(",")}`);
							return { checkout: "checkout" };
						}),
					},
				},
				(ctx) => Object.keys(ctx.services),
			),
			route({ method: "post", services: { routeFile } }, (ctx) => Object.keys(ctx.services)),
		]);

		expect(await (await request(app, "POST")).json()).toEqual(["orders"]);
		expect(ran).toEqual(["route file"]);
		expect(await (await request(app)).json()).toEqual(["orders", "checkout"]);
		expect(ran).toEqual(["route file", "route file", "get method: local orders"]);
		expect((await request(app, "PUT")).status).toBe(405);
		expect(ran).toHaveLength(3);
		await app.dispose();
	});

	it("gives concurrent requests their own instances", async () => {
		let constructed = 0;
		let release = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const app = await createApplication([
			route(
				{
					services: {
						method: scope(["unit"], 0, async () => {
							const unit = { id: ++constructed };
							if (unit.id === 1) await gate;
							return { unit };
						}),
					},
				},
				(ctx) => ctx.services.unit.id,
			),
		]);

		const first = request(app);
		const second = request(app);
		await new Promise((resolve) => setTimeout(resolve, 0));
		release();

		expect(await Promise.all([(await first).json(), (await second).json()])).toEqual([1, 2]);
		expect(constructed).toBe(2);
		await app.dispose();
	});

	it("keeps each stage's mapping frozen and its own", async () => {
		const unit = { hits: 0 };
		const app = await createApplication([
			route({ services: { routeFile: scope(["unit"], 0, () => ({ unit })) } }, (ctx) => {
				ctx.services.unit.hits += 1;
				return {
					frozen: Object.isFrozen(ctx.services),
					replaced: Reflect.set(ctx.services, "unit", {}),
					reassigned: Reflect.set(ctx, "services", {}),
				};
			}),
		]);

		expect(await (await request(app)).json()).toEqual({
			frozen: true,
			replaced: false,
			reassigned: false,
		});
		expect(unit.hits).toBe(1);
		await app.dispose();
	});
});

describe("request-scoped service failures and cleanup", () => {
	const recordingLogger = () => {
		const events: RoutaLogEvent[] = [];
		return { events, logger: createLogger({ sink: (event) => events.push(event) }) };
	};

	it("releases method then route-file services after the chain unwinds and the response is serialized", async () => {
		const order: string[] = [];
		const app = await createApplication([
			route(
				{
					middleware: [passThrough({ after: () => order.push("middleware unwound") })],
					services: {
						routeFile: scope(["a", "b"], 0, ({ onCleanup }) => {
							onCleanup(() => order.push("release a"));
							onCleanup(async () => {
								await Promise.resolve();
								order.push("release b");
							});
							return { a: 1, b: 2 };
						}),
						method: scope(["c"], 1, ({ onCleanup }) => {
							onCleanup(() => order.push("release c"));
							return { c: 3 };
						}),
					},
				},
				() => ({
					toJSON() {
						order.push("serialized");
						return "ok";
					},
				}),
			),
		]);

		const response = await request(app);
		order.push("returned");

		expect(await response.json()).toBe("ok");
		// Development validation may serialize more than once; every pass precedes the unwind.
		expect([...new Set(order)]).toEqual([
			"serialized",
			"middleware unwound",
			"release c",
			"release b",
			"release a",
			"returned",
		]);
		await app.dispose();
	});

	it("keeps the prepared response when cleanup fails, and attempts every callback", async () => {
		const { events, logger } = recordingLogger();
		const released: string[] = [];
		const app = await createApplication(
			[
				route(
					{
						services: {
							routeFile: scope(["a"], 0, ({ onCleanup }) => {
								onCleanup(() => released.push("route file"));
								return { a: 1 };
							}),
							method: scope(["b"], 0, ({ onCleanup }) => {
								onCleanup(() => released.push("first"));
								onCleanup(() => {
									throw new Error("close failed");
								});
								return { b: 2 };
							}),
						},
					},
					(ctx) => ctx.services.a + ctx.services.b,
				),
			],
			{ logger },
		);

		const response = await request(app);

		expect(response.status).toBe(200);
		expect(await response.json()).toBe(3);
		expect(released).toEqual(["first", "route file"]);
		expect(events.find((event) => event.event === "services.cleanup_failed")?.data).toMatchObject({
			failures: [{ error: "close failed" }],
		});
		await app.dispose();
	});

	it("stops the request at a failing factory, releases what was built, and hides the error", async () => {
		const { events, logger } = recordingLogger();
		const ran: string[] = [];
		const app = await createApplication(
			[
				route(
					{
						middleware: [passThrough({ before: () => ran.push("route-file middleware") })],
						services: {
							routeFile: scope(["a"], 0, ({ onCleanup }) => {
								onCleanup(() => ran.push("release route file"));
								return { a: 1 };
							}),
							method: scope(["b"], 1, ({ onCleanup }) => {
								onCleanup(() => ran.push("release partial"));
								throw new Error("database unavailable");
							}),
						},
					},
					() => ran.push("handler"),
				),
			],
			{ logger },
		);

		const response = await request(app);
		const body = await response.text();

		expect(response.status).toBe(500);
		expect(body).not.toContain("database unavailable");
		expect(ran).toEqual(["route-file middleware", "release partial", "release route file"]);
		expect(events.find((event) => event.event === "http.error")?.data).toMatchObject({
			error: "database unavailable",
		});

		// No retry: the next request runs the factory again from scratch.
		await request(app);
		expect(ran.filter((item) => item === "release partial")).toHaveLength(2);
		await app.dispose();
	});

	it("treats a factory's client-looking error as an internal failure", async () => {
		const { events, logger } = recordingLogger();
		const app = await createApplication(
			[
				route(
					{
						services: {
							method: scope(["unit"], 0, () => {
								z.object({ apiKey: z.string({ error: "secret config missing" }) }).parse({});
								return { unit: 1 };
							}),
						},
					},
					() => "unreachable",
				),
			],
			{ logger },
		);

		const response = await request(app);
		const body = await response.text();

		expect(response.status).toBe(500);
		expect(body).not.toContain("secret config missing");
		expect(JSON.parse(body)).toMatchObject({ title: "Internal Server Error" });
		const logged = events.find((event) => event.event === "http.error")?.data;
		expect(logged).toMatchObject({ status: 500, name: "ZodError" });
		expect(logged?.error).toContain("secret config missing");
		expect(logged?.stack).toEqual(expect.any(String));
		await app.dispose();
	});

	it("releases a failed factory's partial cleanup after the chain unwinds, with the built scopes", async () => {
		const order: string[] = [];
		const app = await createApplication([
			route(
				{
					middleware: [
						createMiddleware({
							run: async ({ next }) => {
								try {
									return await next({});
								} finally {
									order.push("middleware finally");
								}
							},
						}) as AnyMiddlewareContract,
					],
					services: {
						routeFile: scope(["a"], 0, ({ onCleanup }) => {
							onCleanup(() => order.push("route cleanup"));
							return { a: 1 };
						}),
						method: scope(["b"], 1, ({ onCleanup }) => {
							onCleanup(() => order.push("method cleanup"));
							throw new Error("method factory failed");
						}),
					},
				},
				() => "unreachable",
			),
		]);

		expect((await request(app)).status).toBe(500);
		expect(order).toEqual(["middleware finally", "method cleanup", "route cleanup"]);
		await app.dispose();
	});

	it("rejects a mapping whose names differ from the contract, after running its cleanup", async () => {
		const { events, logger } = recordingLogger();
		let cleaned = 0;
		const app = await createApplication(
			[
				route(
					{
						services: {
							method: scope(["unit"], 0, ({ onCleanup }) => {
								onCleanup(() => {
									cleaned += 1;
								});
								return { unit: 1, extra: 2 };
							}),
						},
					},
					() => "unreachable",
				),
			],
			{ logger },
		);

		expect((await request(app)).status).toBe(500);
		expect(cleaned).toBe(1);
		expect(events.find((event) => event.event === "http.error")?.data).toMatchObject({
			error:
				'The method services factory for GET /orders must return exactly the declared services ("unit"): unexpected "extra".',
		});
		await app.dispose();
	});

	it("keeps the construction error primary when its cleanup also fails", async () => {
		const { events, logger } = recordingLogger();
		const app = await createApplication(
			[
				route(
					{
						services: {
							routeFile: scope(["unit"], 0, ({ onCleanup }) => {
								onCleanup(() => {
									throw new Error("cleanup failed");
								});
								throw new Error("construction failed");
							}),
						},
					},
					() => "unreachable",
				),
			],
			{ logger },
		);

		expect((await request(app)).status).toBe(500);
		expect(events.map((event) => [event.event, event.data?.error])).toEqual(
			expect.arrayContaining([["http.error", "construction failed"]]),
		);
		expect(events.find((event) => event.event === "services.cleanup_failed")?.data).toMatchObject({
			failures: [{ error: "cleanup failed" }],
		});
		await app.dispose();
	});

	it("skips later factories when middleware rejects, and releases the scopes built before it", async () => {
		const ran: string[] = [];
		const app = await createApplication([
			route(
				{
					middleware: [
						createMiddleware({
							rejects: { denied: { status: 403 } },
							run: () => ({ type: "denied" as const }),
						}) as AnyMiddlewareContract,
					],
					services: {
						routeFile: scope(["a"], 0, ({ onCleanup }) => {
							onCleanup(() => ran.push("release route file"));
							return { a: 1 };
						}),
						method: scope(["b"], 1, () => {
							ran.push("method factory");
							return { b: 2 };
						}),
					},
				},
				() => ran.push("handler"),
			),
		]);

		expect((await request(app)).status).toBe(403);
		expect(ran).toEqual(["release route file"]);
		await app.dispose();
	});

	it("releases request services when the selected response fails validation", async () => {
		const ran: string[] = [];
		const app = await createApplication([
			{
				method: "get",
				path: "/orders",
				contract: createRoute({
					responses: { ok: { status: 200, schema: z.number() } },
					run: () => ({ type: "ok", data: "not a number" as unknown as number }),
				}),
				services: {
					method: scope(["unit"], 0, ({ onCleanup }) => {
						onCleanup(() => ran.push("released"));
						return { unit: 1 };
					}),
				},
			},
		]);

		expect((await request(app)).status).toBe(500);
		expect(ran).toEqual(["released"]);
		await app.dispose();
	});

	it("does not dispose application services until active requests finish their cleanup", async () => {
		const order: string[] = [];
		let finish = () => {};
		const slowCleanup = new Promise<void>((resolve) => {
			finish = resolve;
		});
		const app = await createApplication(
			[
				route(
					{
						services: {
							method: scope(["unit"], 0, ({ onCleanup }) => {
								onCleanup(async () => {
									await slowCleanup;
									order.push("request released");
								});
								return { unit: 1 };
							}),
						},
					},
					(ctx) => ctx.services.db,
				),
			],
			{
				services: {
					names: ["db"],
					factory: ({ onCleanup }) => {
						onCleanup(() => order.push("application released"));
						return { db: "db" };
					},
				},
			},
		);

		const response = request(app);
		await new Promise((resolve) => setTimeout(resolve, 0));
		const disposal = app.dispose();

		await expect(request(app)).rejects.toThrow("accepts no new requests");
		finish();
		await disposal;

		expect(await (await response).json()).toBe("db");
		expect(order).toEqual(["request released", "application released"]);
	});
});

describe("middleware service requirements (runtime)", () => {
	interface CacheRequirements {
		cache: { get(): string };
	}

	/** Middleware requiring `cache` that counts its callback invocations. */
	const requiresCache = (counter: { runs: number }) =>
		createMiddleware<CacheRequirements>()({
			requiresServices: ["cache"],
			provides: { cached: z.string() },
			run: ({ ctx, next }) => {
				counter.runs += 1;
				return next({ cached: ctx.services.cache.get() });
			},
		});

	it("runs middleware whose required services its stage provides", async () => {
		const counter = { runs: 0 };
		const app = await createApplication([
			route(
				{
					middleware: [observe("fs", []), requiresCache(counter)],
					services: {
						routeFile: scope(["cache", "extra"], 1, () => ({
							cache: { get: () => "hit" },
							extra: 1,
						})),
					},
				},
				(ctx) => ctx.cached,
			),
		]);

		expect(await (await request(app)).json()).toBe("hit");
		expect(counter.runs).toBe(1);
		await app.dispose();
	});

	it("stops before a middleware whose required service its stage lacks, and hides why", async () => {
		const events: RoutaLogEvent[] = [];
		const logger = createLogger({ sink: (event) => events.push(event) });
		const counter = { runs: 0 };
		const ran: string[] = [];
		const app = await createApplication(
			[
				{
					...route(
						{
							middleware: [
								passThrough({ before: () => ran.push("earlier") }),
								requiresCache(counter),
								passThrough({ before: () => ran.push("later") }),
							],
							// The cache arrives only after the middleware that requires it.
							services: {
								routeFile: scope(["cache"], 2, ({ onCleanup }) => {
									onCleanup(() => ran.push("released"));
									return { cache: { get: () => "late" } };
								}),
							},
						},
						() => ran.push("handler"),
					),
					middlewareNames: ["withRequest", "withCache", "withAudit"],
				},
			],
			{ logger, services: appServices(["db"], () => ({ db: {} })) },
		);

		const response = await request(app);

		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({
			type: "https://routa-ts.dev/problems/internal",
			title: "Internal Server Error",
			status: 500,
		});
		expect(counter.runs).toBe(0);
		// The failure skips the later middleware, the later factory, and the handler.
		expect(ran).toEqual(["earlier"]);
		expect(events.find((event) => event.event === "http.error")?.data).toMatchObject({
			method: "GET",
			path: "/orders",
			status: 500,
			error:
				'Middleware withCache on GET /orders requires service "cache", but ctx.services does not provide it where the middleware runs. Declare "cache" in a services scope that runs before the middleware.',
		});
		await app.dispose();
	});

	it("checks requirements that bypassed the types, naming middleware by position", async () => {
		const events: RoutaLogEvent[] = [];
		let runs = 0;
		const bypass = createMiddleware({
			requiresServices: ["cache"] as any,
			run: ({ next }) => {
				runs += 1;
				return next();
			},
		});
		const app = createHonoApp([route({ method: "post", middleware: [bypass] }, () => "handled")], {
			logger: createLogger({ sink: (event) => events.push(event) }),
		});

		const response = await app.request("http://localhost/orders", { method: "POST" });

		expect(response.status).toBe(500);
		expect(runs).toBe(0);
		expect(events.find((event) => event.event === "http.error")?.data?.error).toMatch(
			/^Middleware middleware\[0\] on POST \/orders requires service "cache"/,
		);
	});
});

describe("request-scoped service registration", () => {
	it("rejects a name that combined scopes both declare, and allows unrelated reuse", async () => {
		const unit = scope(["unit"], 0, () => ({ unit: 1 }));

		await expect(
			createApplication([route({ services: { routeFile: unit } }, () => null)], {
				services: appServices(["unit"], () => ({ unit: 1 })),
			}),
		).rejects.toThrow(
			'Service "unit" on GET /orders is declared by application services and by route-file services.',
		);
		expect(() =>
			createHonoApp([route({ services: { routeFile: unit, method: unit } }, () => null)]),
		).toThrow("declared by route-file services and by method services");

		const app = await createApplication([
			route({ services: { method: unit } }, (ctx) => typeof ctx.services.unit),
			route(
				{ method: "post", services: { method: scope(["unit"], 0, () => ({ unit: "text" })) } },
				(ctx) => typeof ctx.services.unit,
			),
		]);
		expect(await (await request(app)).json()).toBe("number");
		expect(await (await request(app, "POST")).json()).toBe("string");
		await app.dispose();
	});

	it("rejects a factory placed outside the middleware chain", () => {
		expect(() =>
			createHonoApp([route({ services: { method: scope(["unit"], 1, () => ({})) } }, () => null)]),
		).toThrow("The method services on GET /orders run after 1 middleware, but the route has 0.");
	});
});

/** Type fixtures: compiled, never run. */
function typesOnly(_check: () => void): void {}

interface OrdersServices {
	orders: { list(): string[] };
}

interface CheckoutServices {
	checkout: { pay(): void };
}

typesOnly(() => {
	type App = { db: { query(): string } };
	// What `routa generate` writes: handler context per method, and factory-entry context per scope.
	const createRouteRoot = createRouteRootFactory<
		{
			"/orders": {
				get: {
					fs: string;
					local: number;
					services: Readonly<App & OrdersServices & CheckoutServices>;
				};
				post: { fs: string; local: number; services: Readonly<App & OrdersServices> };
			};
		},
		{
			"/orders": {
				routeFile: { fs: string; services: Readonly<App> };
				get: { fs: string; local: number; services: Readonly<App & OrdersServices> };
			};
		}
	>();
	const defineOrdersServices = defineServices<OrdersServices>();
	const defineCheckoutServices = defineServices<CheckoutServices>();

	createRouteRoot("/orders")({
		services: defineOrdersServices(({ ctx, onCleanup }) => {
			const fs: string = ctx.fs;
			ctx.logger.info("orders.ready", fs);
			ctx.services.db.query();
			// @ts-expect-error Route-file services are not available to their own factory.
			void ctx.services.orders;
			// @ts-expect-error Route-file middleware runs after the route-file factory.
			void ctx.local;
			// @ts-expect-error Factories receive no request input.
			void ctx.input;
			onCleanup(() => {});
			return { orders: { list: () => [fs] } };
		}),
		get: createRoute({
			responses: { ok: { status: 200, schema: z.array(z.string()) } },
			services: defineCheckoutServices(async ({ ctx }) => {
				const local: number = ctx.local;
				await Promise.resolve(ctx.services.orders.list());
				// @ts-expect-error Method services are not available to their own factory.
				void ctx.services.checkout;
				// @ts-expect-error The factory context is readonly.
				ctx.services = { ...ctx.services };
				return { checkout: { pay: () => void local } };
			}),
			run: ({ ctx, response }) => {
				ctx.services.checkout.pay();
				ctx.services.db.query();
				// @ts-expect-error Handlers see the contract, not extra implementation members.
				void ctx.services.orders.extra;
				return response.ok(ctx.services.orders.list());
			},
		}),
		post: createRoute({
			responses: { ok: { status: 200, schema: z.array(z.string()) } },
			run: ({ ctx, response }) => {
				// @ts-expect-error Another method's services stay with that method.
				void ctx.services.checkout;
				return response.ok(ctx.services.orders.list());
			},
		}),
	});

	createRouteRoot("/orders")({
		// @ts-expect-error The factory must return every service its contract names.
		services: defineOrdersServices(() => ({ wrong: true })),
	});
});
