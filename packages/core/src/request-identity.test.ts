import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import {
	createApplication,
	createHonoApp,
	createProjectApplication,
	type HonoRoute,
} from "./hono.js";
import {
	bearer,
	createMiddleware,
	createRoute,
	type RequestServicesFactory,
	requireAuth,
} from "./index.js";
import { createLogger, type RoutaLogEvent } from "./logger.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function capture() {
	const events: RoutaLogEvent[] = [];
	return { events, logger: createLogger({ level: "trace", sink: (event) => events.push(event) }) };
}

const echoRoute: HonoRoute = {
	method: "get",
	path: "/echo",
	contract: createRoute({
		responses: { success: { status: 200, schema: z.object({ requestId: z.string() }) } },
		run: ({ ctx }) => {
			ctx.logger.info("echo.read", "Read the echo.");
			return { type: "success", data: { requestId: ctx.requestId } };
		},
	}),
};

/** One request of each kind of response Routa prepares, and what its event should log. */
type Case = {
	readonly name: string;
	readonly path: string;
	readonly init?: RequestInit;
	readonly status: number;
	readonly route: string;
};

const json = { "content-type": "application/json" };
const cases: readonly Case[] = [
	{
		name: "success",
		path: "/items/1",
		init: { method: "POST", headers: json, body: '{"name":"a"}' },
		status: 201,
		route: "/items/:id",
	},
	{
		name: "validation failure",
		path: "/items/1",
		init: { method: "POST", headers: json, body: "{}" },
		status: 400,
		route: "/items/:id",
	},
	{
		name: "middleware short circuit",
		path: "/items/1?deny=1",
		init: { method: "POST", headers: json, body: '{"name":"a"}' },
		status: 403,
		route: "/items/:id",
	},
	{
		name: "unacceptable media type",
		path: "/items/1",
		init: { method: "POST", headers: { ...json, accept: "text/html" }, body: "{}" },
		status: 406,
		route: "/items/:id",
	},
	{ name: "authentication failure", path: "/private", status: 401, route: "/private" },
	{ name: "framework error", path: "/boom", status: 500, route: "/boom" },
	{
		name: "automatic OPTIONS",
		path: "/items/1",
		init: { method: "OPTIONS" },
		status: 204,
		route: "/items/:id",
	},
	{
		name: "method not allowed",
		path: "/items/1",
		init: { method: "DELETE" },
		status: 405,
		route: "/items/:id",
	},
	{ name: "unmatched", path: "/nowhere?token=secret", status: 404, route: "[Unmatched]" },
];

function matrixApp(logger: ReturnType<typeof capture>["logger"]) {
	const gate = createMiddleware({
		input: { query: z.object({ deny: z.string().optional() }) },
		rejects: { denied: { status: 403, schema: z.object({ requestId: z.string() }) } },
		run: ({ ctx, input, next }) =>
			input.query.deny ? { type: "denied", data: { requestId: ctx.requestId } } : next(),
	});

	return createHonoApp(
		[
			{
				method: "post",
				path: "/items/:id",
				contract: createRoute({
					middleware: [gate],
					input: { body: z.object({ name: z.string() }) },
					responses: { created: { status: 201, schema: z.object({ requestId: z.string() }) } },
					run: async ({ ctx }) => {
						// Overlap the requests, so identity must stay with its own request.
						await new Promise((resolve) => setTimeout(resolve, 5));
						return { type: "created", data: { requestId: ctx.requestId } };
					},
				}),
			},
			{
				method: "get",
				path: "/boom",
				contract: createRoute({
					responses: { ok: { status: 200 } },
					run: () => {
						throw new Error("boom with secret detail");
					},
				}),
			},
			{
				method: "get",
				path: "/private",
				contract: createRoute({
					middleware: [requireAuth()],
					responses: { ok: { status: 200 } },
					run: () => ({ type: "ok" }),
				}),
			},
		],
		{
			logger,
			authentication: {
				principal: z.object({ id: z.string(), type: z.literal("user") }),
				schemes: { token: bearer({ authenticate: () => ({ type: "rejected" }) }) },
			},
		},
	);
}

describe("request identity", () => {
	it("LOG-AC-06 gives a request one generated UUID in context, response header, and logs", async () => {
		const { events, logger } = capture();
		const app = createHonoApp([echoRoute], { logger });

		const response = await app.request("/echo", { headers: { "x-request-id": "forged" } });
		const { requestId } = (await response.json()) as { requestId: string };

		expect(requestId).toMatch(uuid);
		expect(response.headers.get("x-request-id")).toBe(requestId);
		expect(events.map((event) => [event.event, event.data?.requestId])).toEqual([
			["echo.read", requestId],
			["http.response.prepared", requestId],
		]);
	});

	it("LOG-AC-06 identifies every kind of response Routa prepares, across concurrent requests", async () => {
		const { events, logger } = capture();
		const app = matrixApp(logger);
		const sent = [...cases, ...cases];

		const responses = await Promise.all(
			sent.map(({ path, init }) =>
				app.request(path, {
					...init,
					headers: { ...(init?.headers as Record<string, string>), "x-request-id": "forged" },
				}),
			),
		);
		const ids = responses.map((response) => response.headers.get("x-request-id") ?? "");

		expect(responses.map((response) => response.status)).toEqual(sent.map((item) => item.status));
		expect(ids.every((id) => uuid.test(id))).toBe(true);
		expect(new Set(ids).size).toBe(ids.length);

		const prepared = events.filter((event) => event.event === "http.response.prepared");
		expect(prepared).toHaveLength(sent.length);
		for (const [index, item] of sent.entries()) {
			expect(
				prepared.find((event) => event.data?.requestId === ids[index])?.data,
				item.name,
			).toEqual({
				requestId: ids[index],
				method: item.init?.method ?? "GET",
				route: item.route,
				status: item.status,
				durationMs: expect.any(Number),
			});
		}

		// The handler and the short-circuiting middleware saw the identity the response carries.
		expect(await responses[0]?.json()).toEqual({ requestId: ids[0] });
		expect(await responses[2]?.json()).toEqual({ requestId: ids[2] });
		expect(
			events.filter((event) => event.event === "http.error").map((event) => event.data),
		).toEqual(
			expect.arrayContaining([
				{ requestId: ids[5], method: "GET", route: "/boom", status: 500 },
				{ requestId: ids[cases.length + 5], method: "GET", route: "/boom", status: 500 },
			]),
		);
		const logged = JSON.stringify(events);
		expect(logged).not.toContain("forged");
		expect(logged).not.toContain("secret");
		expect(logged).not.toContain("/items/1");
		expect(logged).not.toContain("nowhere");
	});

	it("LOG-AC-07 keeps request identity in logs whatever events and children add", async () => {
		const { events, logger } = capture();
		const route: HonoRoute = {
			method: "get",
			path: "/override",
			contract: createRoute({
				responses: { ok: { status: 200 } },
				run: ({ ctx }) => {
					ctx.logger.info("data.override", "Data names the identity.", {
						requestId: "forged",
						correlationId: "forged",
					});
					ctx.logger.log({
						level: "info",
						event: "log.override",
						message: "A whole event names the identity.",
						timestamp: new Date(0).toISOString(),
						data: { requestId: "forged" },
					});
					const child = ctx.logger.child({ requestId: "forged", step: "child" });
					child.info("child.override", "A child names the identity.");
					child.child({ requestId: "forged again" }).info("grandchild", "So does a grandchild.");
					expect(child.bindings()).toEqual({ requestId: ctx.requestId, step: "child" });
					return { type: "ok" };
				},
			}),
		};
		const app = createHonoApp([route], { logger });

		const response = await app.request("/override");
		const requestId = response.headers.get("x-request-id");

		expect(response.status).toBe(200);
		expect(events.map((event) => [event.event, event.data?.requestId])).toEqual([
			["data.override", requestId],
			["log.override", requestId],
			["child.override", requestId],
			["grandchild", requestId],
			["http.response.prepared", requestId],
		]);
		// No correlation ID was accepted, so the request's events carry none at all.
		expect(events.map((event) => event.data?.correlationId)).toEqual(events.map(() => undefined));
	});

	it("LOG-AC-07 logs only the accepted correlation ID, whatever the configured logger or the event binds", async () => {
		const { events, logger } = capture();
		const route: HonoRoute = {
			method: "get",
			path: "/bound",
			contract: createRoute({
				responses: { ok: { status: 200 } },
				run: ({ ctx }) => {
					ctx.logger.info("data.override", "Data names the correlation.", {
						correlationId: "forged",
					});
					ctx.logger.log({
						level: "info",
						event: "log.override",
						message: "A whole event names the correlation.",
						timestamp: new Date(0).toISOString(),
						data: { correlationId: "forged" },
					});
					const child = ctx.logger.child({ correlationId: "forged", step: "child" });
					child.info("child.override", "A child names the correlation.");
					expect(child.bindings()).toEqual({
						requestId: ctx.requestId,
						...(ctx.correlationId !== undefined && { correlationId: ctx.correlationId }),
						service: "orders",
						step: "child",
					});
					return { type: "ok" };
				},
			}),
		};
		const failing: HonoRoute = {
			method: "get",
			path: "/boom",
			contract: createRoute({
				responses: { ok: { status: 200 } },
				run: () => {
					throw new Error("boom");
				},
			}),
		};
		const configured = logger.child({
			requestId: "process-level",
			correlationId: "process-level",
			service: "orders",
		});

		for (const correlation of [false, true]) {
			for (const headers of [{}, { "x-correlation-id": "trace-1" }] as Array<
				Record<string, string>
			>) {
				events.length = 0;
				const app = createHonoApp([route, failing], { logger: configured, correlation });
				const ok = await app.request("/bound", { headers });
				const failed = await app.request("/boom", { headers });
				const accepted = correlation ? headers["x-correlation-id"] : undefined;
				const label = JSON.stringify({ correlation, headers });

				expect(ok.status, label).toBe(200);
				expect(
					events.map((event) => [
						event.event,
						event.data?.requestId,
						event.data?.correlationId,
						Object.hasOwn(event.data ?? {}, "correlationId"),
					]),
					label,
				).toEqual(
					[
						["data.override", ok],
						["log.override", ok],
						["child.override", ok],
						["http.response.prepared", ok],
						["http.error", failed],
						["http.response.prepared", failed],
					].map(([name, response]) => [
						name,
						(response as Response).headers.get("x-request-id"),
						accepted,
						accepted !== undefined,
					]),
				);
			}
		}
	});

	it("LOG-AC-07 keeps identity and Routa's event fields when the configured logger is full of bindings", async () => {
		const { events, logger } = capture();
		const bindings = Object.fromEntries(
			Array.from({ length: 100 }, (_, index) => [`b${index}`, index]),
		);
		const boom: HonoRoute = {
			method: "get",
			path: "/boom",
			contract: createRoute({
				responses: { ok: { status: 200 } },
				run: () => {
					throw new Error("boom");
				},
			}),
		};
		const app = createHonoApp([echoRoute, boom], {
			logger: logger.child(bindings),
			correlation: true,
		});

		const ok = await app.request("/echo", { headers: { "x-correlation-id": "trace-1" } });
		const failed = await app.request("/boom", { headers: { "x-correlation-id": "trace-2" } });
		const data = (name: string, response: Response) =>
			events.find(
				(event) =>
					event.event === name && event.data?.requestId === response.headers.get("x-request-id"),
			)?.data;
		const identity = (response: Response, correlationId: string) => ({
			requestId: response.headers.get("x-request-id"),
			correlationId,
		});

		expect(data("echo.read", ok)).toMatchObject(identity(ok, "trace-1"));
		expect(data("http.response.prepared", ok)).toMatchObject({
			...identity(ok, "trace-1"),
			method: "GET",
			route: "/echo",
			status: 200,
			durationMs: expect.any(Number),
		});
		expect(data("http.error", failed)).toMatchObject({
			...identity(failed, "trace-2"),
			method: "GET",
			route: "/boom",
			status: 500,
		});
		expect(data("http.response.prepared", failed)).toMatchObject({
			...identity(failed, "trace-2"),
			status: 500,
		});
		// The limits still hold: the application's bindings are the fields left out.
		for (const event of events) {
			expect(Object.keys(event.data ?? {}).length, event.event).toBe(101);
			expect(event.data?.["[Truncated]"], event.event).toBe("[Truncated]");
		}
	});

	it("LOG-AC-07 leaves a shared logger without request identity, and requests apart", async () => {
		const { events, logger } = capture();
		const route: HonoRoute = {
			method: "get",
			path: "/shared",
			contract: createRoute({
				responses: { ok: { status: 200 } },
				run: async ({ ctx }) => {
					// The imported logger and the request logger write to one sink.
					logger.info("shared.write", "Written through the shared logger.");
					await new Promise((resolve) => setTimeout(resolve, 2));
					ctx.logger.info("request.write", "Written through the request logger.");
					return { type: "ok" };
				},
			}),
		};
		const app = createHonoApp([route], { logger });

		const responses = await Promise.all([app.request("/shared"), app.request("/shared")]);
		const ids = responses.map((response) => response.headers.get("x-request-id"));

		expect(
			events.filter((event) => event.event === "shared.write").map((event) => event.data),
		).toEqual([undefined, undefined]);
		expect(
			events
				.filter((event) => event.event === "request.write")
				.map((event) => event.data?.requestId),
		).toEqual(expect.arrayContaining(ids));
		logger.info("after.requests", "The shared logger after both requests.");
		expect(events.at(-1)?.data).toBeUndefined();
	});

	it("LOG-AC-07 fails middleware that overwrites or passes on the identity, keeping the real one", async () => {
		const writes = createMiddleware({
			run: ({ ctx, next }) => {
				(ctx as { requestId: string }).requestId = "forged";
				return next();
			},
		});
		const passes = createMiddleware({
			run: ({ next }) => next({ requestId: "forged" } as never),
		});
		const passesLogger = createMiddleware({
			run: ({ next }) => next({ logger: "forged" } as never),
		});
		// Passing the whole context on passes its identity and logger too.
		const passesContext = createMiddleware({
			run: ({ ctx, next }) => next(ctx),
		});
		const reached: string[] = [];
		const route = (path: string, middleware: unknown): HonoRoute => ({
			method: "get",
			path,
			contract: createRoute({
				middleware: [middleware as typeof writes],
				responses: { ok: { status: 200 } },
				run: ({ ctx }) => {
					reached.push(ctx.requestId);
					return { type: "ok" };
				},
			}),
		});
		const app = createHonoApp([
			route("/writes", writes),
			route("/passes", passes),
			route("/logger", passesLogger),
			route("/context", passesContext),
		]);

		for (const path of ["/writes", "/passes", "/logger", "/context"]) {
			const response = await app.request(path);
			expect(response.status, path).toBe(500);
			expect(response.headers.get("x-request-id"), path).toMatch(uuid);
		}
		expect(reached).toEqual([]);
	});

	it("LOG-AC-07 fails middleware that assigns ctx.correlationId when no correlation ID was accepted", async () => {
		const writes = createMiddleware({
			run: ({ ctx, next }) => {
				(ctx as { correlationId?: string }).correlationId = "forged";
				return next();
			},
		});
		const reached: unknown[] = [];
		const route: HonoRoute = {
			method: "get",
			path: "/",
			contract: createRoute({
				middleware: [writes],
				responses: { ok: { status: 200 } },
				run: ({ ctx }) => {
					reached.push(ctx.correlationId);
					return { type: "ok" };
				},
			}),
		};

		for (const options of [{}, { correlation: true }] as const) {
			const response = await createHonoApp([route], options).request("/");
			expect(response.status, JSON.stringify(options)).toBe(500);
			expect(response.headers.get("x-correlation-id")).toBeNull();
		}
		expect(reached).toEqual([]);
	});

	it("LOG-AC-07 fails middleware that assigns or deletes ctx.logger, keeping the request logger", async () => {
		const { events, logger } = capture();
		const appLogger = createLogger({ sink: () => undefined });
		const writes = createMiddleware({
			run: ({ ctx, next }) => {
				(ctx as { logger?: unknown }).logger = appLogger;
				return next();
			},
		});
		const deletes = createMiddleware({
			run: ({ ctx, next }) => {
				delete (ctx as { logger?: unknown }).logger;
				return next();
			},
		});
		const reached: string[] = [];
		const route = (path: string, middleware: typeof writes): HonoRoute => ({
			method: "get",
			path,
			contract: createRoute({
				middleware: [middleware],
				responses: { ok: { status: 200 } },
				run: () => {
					reached.push(path);
					return { type: "ok" };
				},
			}),
		});
		const app = createHonoApp([route("/writes", writes), route("/deletes", deletes)], { logger });

		for (const path of ["/writes", "/deletes"]) {
			const response = await app.request(path);
			expect(response.status, path).toBe(500);
			expect(
				events.find((event) => event.event === "http.error" && event.data?.route === path)?.data
					?.requestId,
				path,
			).toBe(response.headers.get("x-request-id"));
		}
		expect(reached).toEqual([]);
	});

	it("LOG-AC-07 rejects middleware that provides a reserved context key through a compiler bypass", () => {
		for (const key of ["requestId", "correlationId", "logger"]) {
			const provides = createMiddleware({
				provides: { [key]: z.string() } as Record<string, z.ZodTypeAny>,
			});
			expect(() =>
				createHonoApp([
					{
						method: "get",
						path: "/",
						contract: createRoute({
							middleware: [provides],
							responses: { ok: { status: 200 } },
							run: () => ({ type: "ok" }),
						}),
					},
				]),
			).toThrow(`middleware[0] on GET / provides ctx.${key}, which Routa reserves for`);
		}
	});

	it("LOG-AC-07 owns x-request-id over a declaration or handler that claims it", async () => {
		const declares = {
			responses: { ok: { status: 200, headers: z.object({ "x-request-id": z.string() }) } },
			run: () => ({ type: "ok" }),
		};
		expect(() => createHonoApp([{ method: "get", path: "/", contract: declares }])).toThrow(
			'declares header "x-request-id", but Routa owns x-request-id.',
		);

		const writes = createRoute({
			responses: { ok: { status: 200 } },
			run: () => ({ type: "ok", headers: { "x-request-id": "forged" } }) as never,
		});
		const response = await createHonoApp([{ method: "get", path: "/", contract: writes }]).request(
			"/",
		);

		expect(response.status).toBe(500);
		expect(response.headers.get("x-request-id")).toMatch(uuid);
	});

	it("LOG-AC-06 gives a services factory the identity and request logger its handler gets", async () => {
		const { events, logger } = capture();
		const seen: unknown[] = [];
		const route: HonoRoute = {
			method: "get",
			path: "/scoped",
			contract: createRoute({
				responses: { ok: { status: 200, schema: z.object({ requestId: z.string() }) } },
				run: ({ ctx }) => ({ type: "ok", data: { requestId: ctx.requestId } }),
			}),
			services: {
				method: {
					names: ["audit"],
					after: 0,
					factory: ({ ctx, onCleanup }) => {
						seen.push(ctx.requestId, ctx.correlationId);
						onCleanup(() => ctx.logger.info("audit.flushed", "Audit flushed."));
						return { audit: {} };
					},
				},
			},
		};
		const app = createHonoApp([route], { logger, correlation: true });

		const response = await app.request("/scoped", { headers: { "x-correlation-id": "c-1" } });
		const requestId = response.headers.get("x-request-id");

		expect(await response.json()).toEqual({ requestId });
		expect(seen).toEqual([requestId, "c-1"]);
		expect(events.find((event) => event.event === "audit.flushed")?.data).toEqual({
			requestId,
			correlationId: "c-1",
		});
	});

	it("LOG-AC-12 logs a method outside the standard set as _OTHER", async () => {
		const { events, logger } = capture();
		const app = createHonoApp([echoRoute], { logger });

		const responses = [
			await app.request("/echo", { method: "PROPFIND" }),
			await app.request("/echo", { method: "patch" }),
			await app.request("/nowhere", { method: "BREW" }),
		];

		expect(responses.map((response) => response.status)).toEqual([405, 405, 404]);
		expect(
			events
				.filter((event) => event.event === "http.response.prepared")
				.map((event) => [event.data?.method, event.data?.route]),
		).toEqual([
			["_OTHER", "/echo"],
			["_OTHER", "/echo"],
			["_OTHER", "[Unmatched]"],
		]);
		expect(JSON.stringify(events)).not.toMatch(/PROPFIND|BREW|"patch"/);
	});

	it("LOG-AC-12 logs invalid handler output without the request data its issue paths hold", async () => {
		const { events, logger } = capture();
		const totals = createRoute({
			input: { query: z.object({ key: z.string() }) },
			responses: { ok: { status: 200, schema: z.record(z.string(), z.number()) } },
			run: ({ input }) =>
				({ type: "ok", data: { [input.query.key]: "one", other: "two" } }) as never,
		});
		const app = createHonoApp([{ method: "get", path: "/totals", contract: totals }], { logger });

		const response = await app.request("/totals?key=alice@example.com");

		expect(response.status).toBe(500);
		expect(events.find((event) => event.event === "http.error")?.data).toEqual({
			requestId: response.headers.get("x-request-id"),
			method: "GET",
			route: "/totals",
			status: 500,
			issueCount: 2,
			issueCodes: ["invalid_type"],
		});
		expect(JSON.stringify(events)).not.toContain("alice");
	});

	it("LOG-AC-12 logs no preparation when no response was prepared", async () => {
		const { events, logger } = capture();
		const app = createHonoApp([echoRoute], { logger });
		// A handler added to the returned Hono app that throws a non-Error escapes Hono's error
		// handler, so no response is ever prepared for the request.
		app.get("/raw", () => {
			throw "not an Error";
		});

		await expect(app.request("/raw")).rejects.toBe("not an Error");
		expect(events.filter((event) => event.event === "http.response.prepared")).toEqual([]);
	});

	it("LOG-AC-06 identifies a response whose headers are immutable, such as Response.redirect()", async () => {
		const { events, logger } = capture();
		const app = createHonoApp([], { logger, correlation: true });
		app.get("/old", () => Response.redirect("https://example.com/new", 302));

		const response = await app.request("/old", { headers: { "x-correlation-id": "trace-1" } });

		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toBe("https://example.com/new");
		expect(response.headers.get("x-request-id")).toMatch(uuid);
		expect(response.headers.get("x-correlation-id")).toBe("trace-1");
		expect(events.map((event) => [event.event, event.data])).toEqual([
			[
				"http.response.prepared",
				expect.objectContaining({
					requestId: response.headers.get("x-request-id"),
					correlationId: "trace-1",
					route: "[Unmatched]",
					status: 302,
				}),
			],
		]);
	});

	it("LOG-AC-07 never writes one request's identity on a Response an application reuses", async () => {
		const cached = new Response(null, { status: 200, headers: { "cache-control": "max-age=60" } });
		const app = createHonoApp([], { correlation: true });
		app.get("/cached", () => cached);

		const first = await app.request("/cached", { headers: { "x-correlation-id": "customer-a" } });
		const second = await app.request("/cached");

		expect(first.headers.get("x-correlation-id")).toBe("customer-a");
		expect(second.headers.get("x-correlation-id")).toBeNull();
		expect(second.headers.get("x-request-id")).toMatch(uuid);
		expect(second.headers.get("x-request-id")).not.toBe(first.headers.get("x-request-id"));
		expect(second.headers.get("cache-control")).toBe("max-age=60");

		const sent = Array.from({ length: 6 }, (_, index): Record<string, string> =>
			index % 2 === 0 ? { "x-correlation-id": `customer-${index}` } : {},
		);
		const concurrent = await Promise.all(
			sent.map((headers) => app.request("/cached", { headers })),
		);

		expect(concurrent.map((response) => response.headers.get("x-correlation-id"))).toEqual(
			sent.map((headers) => headers["x-correlation-id"] ?? null),
		);
		expect(new Set(concurrent.map((response) => response.headers.get("x-request-id"))).size).toBe(
			sent.length,
		);
		expect([...cached.headers]).toEqual([["cache-control", "max-age=60"]]);
	});

	it("LOG-AC-12 returns a response it cannot copy, such as a 101 upgrade, as it is", async () => {
		const { events, logger } = capture();
		const app = createHonoApp([], { logger, correlation: true });
		// Node's Response constructor rejects 101, so this stands in for the upgrade response a
		// runtime builds itself, such as the one Deno.upgradeWebSocket() returns.
		const upgrade = new Response(null, {
			headers: { upgrade: "websocket", connection: "Upgrade" },
		});
		Object.defineProperty(upgrade, "status", { value: 101 });
		app.get("/socket", () => upgrade);

		const response = await app.request("/socket", {
			headers: { upgrade: "websocket", "x-correlation-id": "trace-1" },
		});

		expect(response).toBe(upgrade);
		expect([...upgrade.headers]).toEqual([
			["connection", "Upgrade"],
			["upgrade", "websocket"],
		]);
		expect(events.map((event) => [event.event, event.data])).toEqual([
			[
				"http.response.prepared",
				{
					requestId: expect.stringMatching(uuid),
					correlationId: "trace-1",
					method: "GET",
					route: "[Unmatched]",
					status: 101,
					durationMs: expect.any(Number),
				},
			],
		]);
	});

	it("LOG-AC-06 fails a request nothing on the Hono app answered as a 500 that carries its identity", async () => {
		const { events, logger } = capture();
		const app = createHonoApp([], { logger, correlation: true });
		// Sets a header, then neither returns a response nor calls next().
		app.use("/silent", (context) => {
			context.header("x-written", "kept");
			return Promise.resolve();
		});
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			const response = await app.request("/silent", {
				headers: { "x-correlation-id": "trace-1" },
			});

			expect(response.status).toBe(500);
			expect(await response.text()).toBe("Internal Server Error");
			expect(response.headers.get("x-request-id")).toMatch(uuid);
			expect(response.headers.get("x-correlation-id")).toBe("trace-1");
			expect(events.map((event) => [event.event, event.data])).toEqual([
				[
					"http.response.prepared",
					{
						requestId: response.headers.get("x-request-id"),
						correlationId: "trace-1",
						method: "GET",
						route: "[Unmatched]",
						status: 500,
						durationMs: expect.any(Number),
					},
				],
			]);
			// Hono's error handler received the error Hono fails an unanswered request with.
			expect(errors).toHaveBeenCalledWith(
				expect.objectContaining({ message: expect.stringContaining("Context is not finalized") }),
			);
		} finally {
			errors.mockRestore();
		}

		// An error handler the application installs answers instead, and still gets identity.
		app.onError((_error, context) => context.text("handled", 503));
		const handled = await app.request("/silent");

		expect(handled.status).toBe(503);
		expect(await handled.text()).toBe("handled");
		expect(handled.headers.get("x-request-id")).toMatch(uuid);
		expect(events.at(-1)?.data).toMatchObject({
			requestId: handled.headers.get("x-request-id"),
			status: 503,
		});
	});

	it("LOG-AC-06 identifies a request once when one Routa app is mounted in another", async () => {
		const outer = capture();
		const inner = capture();
		const whoami: HonoRoute = {
			method: "get",
			path: "/whoami",
			contract: createRoute({
				responses: {
					ok: {
						status: 200,
						schema: z.object({ requestId: z.string(), correlationId: z.string().nullable() }),
					},
				},
				run: ({ ctx }) => {
					ctx.logger.info("whoami.read", "Read the identity.");
					return {
						type: "ok",
						data: { requestId: ctx.requestId, correlationId: ctx.correlationId ?? null },
					};
				},
			}),
		};
		const mounted = (correlation: boolean) => {
			const app = createHonoApp([], { logger: outer.logger, correlation });
			app.route("/api", createHonoApp([whoami], { logger: inner.logger, correlation: true }));
			return app;
		};
		const prepared = () =>
			[...outer.events, ...inner.events].filter(
				(event) => event.event === "http.response.prepared",
			);

		const response = await mounted(true).request("/api/whoami", {
			headers: { "x-correlation-id": "trace-1" },
		});
		const body = (await response.json()) as { requestId: string; correlationId: string };

		expect(body).toEqual({ requestId: expect.stringMatching(uuid), correlationId: "trace-1" });
		expect(response.headers.get("x-request-id")).toBe(body.requestId);
		expect(response.headers.get("x-correlation-id")).toBe("trace-1");
		// The outer app identified the request and logged it; the mounted app's handler logged
		// through its own logger with the same identity.
		expect(outer.events.map((event) => [event.event, event.data])).toEqual([
			[
				"http.response.prepared",
				{
					requestId: body.requestId,
					correlationId: "trace-1",
					method: "GET",
					route: "/whoami",
					status: 200,
					durationMs: expect.any(Number),
				},
			],
		]);
		expect(inner.events.map((event) => [event.event, event.data])).toEqual([
			["whoami.read", { requestId: body.requestId, correlationId: "trace-1" }],
		]);

		for (const [path, init, status, route] of [
			["/api/nowhere", {}, 404, "[Unmatched]"],
			["/api/whoami", { method: "DELETE" }, 405, "/whoami"],
		] as const) {
			outer.events.length = 0;
			inner.events.length = 0;
			const other = await mounted(true).request(path, init);

			expect(other.status, path).toBe(status);
			expect(
				prepared().map((event) => event.data),
				path,
			).toEqual([
				expect.objectContaining({ requestId: other.headers.get("x-request-id"), route, status }),
			]);
		}

		// The outer app's correlation config decides for the whole request.
		const uncorrelated = await mounted(false).request("/api/whoami", {
			headers: { "x-correlation-id": "trace-1" },
		});
		const uncorrelatedBody = (await uncorrelated.json()) as { correlationId: string | null };

		expect(uncorrelatedBody.correlationId).toBeNull();
		expect(uncorrelated.headers.has("x-correlation-id")).toBe(false);
	});

	it("LOG-AC-06 lets the outer app's middleware answer what a mounted Routa app left unanswered", async () => {
		const outer = capture();
		const inner = capture();
		const app = createHonoApp([], { logger: outer.logger, correlation: true });
		// Supplies its own response when nothing after it answered the request.
		app.use("*", async (context, next) => {
			await next();

			if (!context.finalized) {
				return context.text("fallback", 202);
			}
		});
		const mounted = createHonoApp([], { logger: inner.logger });
		// Sets a header, then neither returns a response nor calls next().
		mounted.use("/quiet", (context) => {
			context.header("x-written", "kept");
			return Promise.resolve();
		});
		app.route("/api", mounted);

		const response = await app.request("/api/quiet", {
			headers: { "x-correlation-id": "trace-1" },
		});

		expect(response.status).toBe(202);
		expect(await response.text()).toBe("fallback");
		expect(response.headers.get("x-written")).toBe("kept");
		expect(response.headers.get("x-request-id")).toMatch(uuid);
		expect(response.headers.get("x-correlation-id")).toBe("trace-1");
		expect(outer.events.map((event) => [event.event, event.data])).toEqual([
			[
				"http.response.prepared",
				{
					requestId: response.headers.get("x-request-id"),
					correlationId: "trace-1",
					method: "GET",
					route: "[Unmatched]",
					status: 202,
					durationMs: expect.any(Number),
				},
			],
		]);
		expect(inner.events).toEqual([]);
	});

	it("LOG-AC-07 binds each request's identity when a request logger configures another app", async () => {
		const child = capture();
		const childRoute: HonoRoute = {
			method: "get",
			path: "/child",
			contract: createRoute({
				responses: {
					ok: {
						status: 200,
						schema: z.object({ requestId: z.string(), correlationId: z.string().nullable() }),
					},
				},
				run: ({ ctx }) => {
					ctx.logger.info("child.read", "Read the identity.");
					return {
						type: "ok",
						data: { requestId: ctx.requestId, correlationId: ctx.correlationId ?? null },
					};
				},
			}),
		};
		// The child app is created lazily, configured with the first request's ctx.logger.
		let childApp: ReturnType<typeof createHonoApp> | undefined;
		const parentRoute: HonoRoute = {
			method: "get",
			path: "/parent",
			contract: createRoute({
				responses: { ok: { status: 200, schema: z.object({ requestId: z.string() }) } },
				run: ({ ctx }) => {
					childApp ??= createHonoApp([childRoute], { logger: ctx.logger, correlation: true });
					return { type: "ok", data: { requestId: ctx.requestId } };
				},
			}),
		};
		const parent = createHonoApp([parentRoute], { logger: child.logger, correlation: true });
		const first = await parent.request("/parent", { headers: { "x-correlation-id": "first" } });
		const firstId = ((await first.json()) as { requestId: string }).requestId;
		child.events.length = 0;

		for (const correlation of ["second", undefined]) {
			const response = await childApp!.request("/child", {
				headers: correlation === undefined ? {} : { "x-correlation-id": correlation },
			});
			const body = (await response.json()) as { requestId: string; correlationId: string | null };
			const identity = {
				requestId: body.requestId,
				...(correlation !== undefined && { correlationId: correlation }),
			};

			expect(body.requestId, correlation).not.toBe(firstId);
			expect(body.correlationId, correlation).toBe(correlation ?? null);
			expect(response.headers.get("x-request-id"), correlation).toBe(body.requestId);
			expect(
				child.events.map((event) => [event.event, event.data]),
				correlation,
			).toEqual([
				["child.read", identity],
				[
					"http.response.prepared",
					{
						...identity,
						method: "GET",
						route: "/child",
						status: 200,
						durationMs: expect.any(Number),
					},
				],
			]);
			child.events.length = 0;
		}
	});

	it("LOG-AC-07 keeps identity in context and headers with logging off", async () => {
		const app = await createApplication([echoRoute]);

		const response = await app.fetch(new Request("http://localhost/echo"));
		const { requestId } = (await response.json()) as { requestId: string };

		expect(requestId).toMatch(uuid);
		expect(response.headers.get("x-request-id")).toBe(requestId);
		await app.dispose();
	});
});

const correlationRoute: HonoRoute = {
	method: "get",
	path: "/correlate",
	contract: createRoute({
		responses: {
			ok: {
				status: 200,
				schema: z.object({ correlationId: z.string().nullable(), readonly: z.boolean() }),
			},
		},
		run: ({ ctx }) => {
			ctx.logger.info("correlate.read", "Read the correlation.", { correlationId: "forged" });
			return {
				type: "ok",
				data: {
					correlationId: ctx.correlationId ?? null,
					// Defined in every case, `undefined` when none was accepted, so nothing can assign it.
					readonly: Object.getOwnPropertyDescriptor(ctx, "correlationId")?.writable === false,
				},
			};
		},
	}),
};

async function correlate(
	options: Parameters<typeof createHonoApp>[1],
	headers: HeadersInit,
): Promise<{ correlationId: string | null; readonly: boolean; echoed: Headers; logged: string }> {
	const { events, logger } = capture();
	const response = await createHonoApp([correlationRoute], { ...options, logger }).request(
		"/correlate",
		{ headers },
	);
	const body = (await response.json()) as { correlationId: string | null; readonly: boolean };
	return { ...body, echoed: response.headers, logged: JSON.stringify(events) };
}

describe("correlation identity", () => {
	it("LOG-AC-08 ignores correlation headers unless correlation is configured", async () => {
		for (const correlation of [undefined, false]) {
			const result = await correlate({ correlation }, { "x-correlation-id": "abc-123" });

			expect(result).toMatchObject({ correlationId: null, readonly: true });
			expect(result.echoed.has("x-correlation-id")).toBe(false);
			expect(result.logged).not.toContain("abc-123");
		}
	});

	it("LOG-AC-08 accepts, exposes, logs, and echoes one valid value of the default header", async () => {
		const result = await correlate(
			{ correlation: true },
			{ "X-Correlation-ID": "Order_42.retry-1" },
		);

		expect(result).toMatchObject({ correlationId: "Order_42.retry-1", readonly: true });
		expect(result.echoed.get("x-correlation-id")).toBe("Order_42.retry-1");
		const events = JSON.parse(result.logged) as RoutaLogEvent[];
		expect(events.map((event) => event.data?.correlationId)).toEqual([
			"Order_42.retry-1",
			"Order_42.retry-1",
		]);
		expect(result.logged).not.toContain("forged");
	});

	it("LOG-AC-08 reads a custom header in any casing and leaves the default one alone", async () => {
		const result = await correlate(
			{ correlation: { header: "X-Trace-Ref" } },
			{ "x-TRACE-ref": "trace-1", "x-correlation-id": "ignored" },
		);

		expect(result).toMatchObject({ correlationId: "trace-1", readonly: true });
		expect(result.echoed.get("x-trace-ref")).toBe("trace-1");
		expect(result.echoed.has("x-correlation-id")).toBe(false);
		expect(result.logged).not.toContain("ignored");
	});

	it("LOG-AC-08 accepts 1 to 128 allowed characters and ignores everything else", async () => {
		const accepted = ["a", "x".repeat(128), "AZaz09._-"];
		const repeated = new Headers();
		repeated.append("x-correlation-id", "first");
		repeated.append("x-correlation-id", "second");
		const ignored: HeadersInit[] = [
			{ "x-correlation-id": "" },
			{ "x-correlation-id": "x".repeat(129) },
			{ "x-correlation-id": "has space" },
			{ "x-correlation-id": "a/b" },
			{ "x-correlation-id": "a:b" },
			{ "x-correlation-id": "a,b" },
			{ "x-correlation-id": "a+b" },
			{ "x-correlation-id": "café" },
			repeated,
		];

		for (const value of accepted) {
			const result = await correlate({ correlation: true }, { "x-correlation-id": value });
			expect(result.correlationId, value).toBe(value);
			expect(result.echoed.get("x-correlation-id"), value).toBe(value);
		}

		for (const headers of ignored) {
			const sent = new Headers(headers).get("x-correlation-id") ?? "";
			const result = await correlate({ correlation: true }, headers);
			expect(result, sent).toMatchObject({ correlationId: null, readonly: true });
			expect(result.echoed.has("x-correlation-id"), sent).toBe(false);
			if (sent) {
				expect(result.logged, sent).not.toContain(JSON.stringify(sent).slice(1, -1));
			}
		}
	});

	it("LOG-AC-09 rejects a correlation header that is invalid, x-request-id, Routa's, or a credential", () => {
		for (const [correlation, message] of [
			[{ header: "X-Request-ID" }, 'The correlation header "X-Request-ID" names x-request-id'],
			[
				{ header: "Authorization" },
				'The correlation header "Authorization" names a credential header',
			],
			[{ header: "proxy-authorization" }, "names a credential header"],
			[{ header: "Cookie" }, "names a credential header"],
			[{ header: "set-cookie" }, "names a credential header"],
			[{ header: "Content-Type" }, "names content-type, which Routa owns on every response"],
			[{ header: "x correlation" }, "is not a valid header name"],
			[{ header: "" }, "is not a valid header name"],
			[{ header: 1 }, "correlation must be true, false, or { header"],
			[{ name: "x-trace" }, "correlation must be true, false, or { header"],
			["x-correlation-id", "correlation must be true, false, or { header"],
		] as const) {
			expect(() => createHonoApp([], { correlation: correlation as never }), message).toThrow(
				message,
			);
		}
	});

	it("LOG-AC-09 rejects every header Routa writes itself as the correlation header", () => {
		for (const [header, owner] of [
			["Allow", "Routa sets on automatic OPTIONS and 405 responses"],
			["access-control-allow-methods", "Routa sets on automatic OPTIONS responses"],
			["Vary", "Routa sets on automatic OPTIONS responses"],
			["Deprecation", "Routa's lifecycle headers emit"],
			["sunset", "Routa's lifecycle headers emit"],
			["Link", "Routa's lifecycle headers emit"],
			["WWW-Authenticate", "Routa's authentication challenges use"],
		] as const) {
			expect(() => createHonoApp([], { correlation: { header } }), header).toThrow(
				`The correlation header ${JSON.stringify(header)} names ${header.toLowerCase()}, which ${owner}.`,
			);
		}
	});

	it("LOG-AC-10 owns the configured correlation header on every response, and no other header", async () => {
		const app = createHonoApp([], { correlation: { header: "x-trace-ref" } });
		// Forwards the headers an upstream service sent, as a proxy route might.
		app.get(
			"/raw",
			() =>
				new Response("ok", {
					headers: {
						"X-Trace-Ref": "stale-upstream-123",
						"x-correlation-id": "upstream",
						"x-other": "kept",
					},
				}),
		);

		const responses = {
			absent: await app.request("/raw"),
			ignored: await app.request("/raw", { headers: { "x-trace-ref": "has space" } }),
			accepted: await app.request("/raw", { headers: { "x-trace-ref": "trace-1" } }),
		};

		expect(
			Object.fromEntries(
				Object.entries(responses).map(([name, response]) => [
					name,
					response.headers.get("x-trace-ref"),
				]),
			),
		).toEqual({ absent: null, ignored: null, accepted: "trace-1" });
		for (const [name, response] of Object.entries(responses)) {
			expect(response.headers.get("x-correlation-id"), name).toBe("upstream");
			expect(response.headers.get("x-other"), name).toBe("kept");
		}

		// With correlation off, Routa owns no correlation header.
		const off = createHonoApp([]);
		off.get("/raw", () => new Response("ok", { headers: { "x-correlation-id": "upstream" } }));
		expect((await off.request("/raw")).headers.get("x-correlation-id")).toBe("upstream");
	});

	it("LOG-AC-08 echoes the header startup checked, whatever the services factory changes later", async () => {
		// Each factory changes the correlation config after startup checked it.
		const changing = (correlation: { header: string }) => () => {
			correlation.header = "x-other";
			return { clock: {} };
		};
		const projected = { header: "x-trace-ref" };
		const direct = { header: "x-trace-ref" };
		const modules: Record<string, unknown> = {
			".routa/routes.gen.ts": {
				routaCorrelationHeader: "x-trace-ref",
				routaApplicationServices: ["clock"],
				routaRoutes: [
					{
						file: "src/routes/echo/route.ts",
						path: "/echo",
						methods: ["GET"],
						middlewareFiles: [],
					},
				],
			},
			"src/routa.ts": {
				default: { logger: false, correlation: projected, services: changing(projected) },
			},
			"src/routes/echo/route.ts": { default: { get: echoRoute.contract } },
		};
		const applications = [
			(await createProjectApplication(async (file) => modules[file], { runtimeMode: "start" }))
				.application,
			await createApplication([echoRoute], {
				correlation: direct,
				services: { factory: changing(direct), names: ["clock"] },
			}),
		];

		for (const application of applications) {
			const response = await application.fetch(
				new Request("http://localhost/echo", {
					headers: { "x-trace-ref": "trace-1", "x-other": "forged" },
				}),
			);

			expect(response.headers.get("x-trace-ref")).toBe("trace-1");
			expect(response.headers.get("x-other")).toBeNull();
			await application.dispose();
		}
	});

	it("LOG-AC-10 owns the correlation header over a declaration or handler that claims it", async () => {
		const declares = createRoute({
			responses: { ok: { status: 200, headers: z.object({ "x-trace-ref": z.string() }) } },
			run: () => ({ type: "ok", headers: { "x-trace-ref": "mine" } }),
		});
		const route: HonoRoute = { method: "get", path: "/", contract: declares };
		expect(() => createHonoApp([route], { correlation: { header: "X-Trace-Ref" } })).toThrow(
			'declares header "x-trace-ref", but Routa echoes the correlation ID in x-trace-ref.',
		);
		expect(() => createHonoApp([route], { correlation: true })).not.toThrow();
	});
});

describe("request identity (types)", () => {
	it("LOG-AC-10 types the identity readonly in handlers and services factories", () => {
		typesOnly(() => {
			createRoute({
				responses: { ok: { status: 200 } },
				run: ({ ctx }) => {
					expectType<string>(ctx.requestId);
					expectType<string | undefined>(ctx.correlationId);
					// @ts-expect-error The request identity is readonly.
					ctx.requestId = "forged";
					// @ts-expect-error So is the correlation ID.
					ctx.correlationId = "forged";
					return { type: "ok" };
				},
			});

			const factory: RequestServicesFactory<{ audit: string }> = ({ ctx }) => {
				expectType<string>(ctx.requestId);
				expectType<string | undefined>(ctx.correlationId);
				return { audit: ctx.requestId };
			};
			void factory;
		});
	});
});

function typesOnly(_check: () => void): void {}

function expectType<T>(_value: T): void {}
