import { describe, expect, it } from "vite-plus/test";
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
		// Correlation is off, so the data's own correlationId field is ordinary data.
		expect(events[0]?.data?.correlationId).toBe("forged");
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
		]);

		for (const path of ["/writes", "/passes", "/logger"]) {
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

	it("LOG-AC-08 echoes only an accepted value and never removes a header something else wrote", async () => {
		const app = createHonoApp([], { correlation: { header: "x-trace-ref" } });
		app.get("/raw", () => new Response("ok", { headers: { "x-trace-ref": "written" } }));

		const ignored = await app.request("/raw", { headers: { "x-trace-ref": "has space" } });
		const accepted = await app.request("/raw", { headers: { "x-trace-ref": "trace-1" } });

		expect(ignored.headers.get("x-trace-ref")).toBe("written");
		expect(accepted.headers.get("x-trace-ref")).toBe("trace-1");
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
					{ file: "src/routes/echo/route.ts", path: "/echo", methods: ["GET"], middlewareFiles: [] },
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
