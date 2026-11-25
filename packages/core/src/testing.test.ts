import { describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { createMiddleware, createRoute, type RequestServicesContext } from "./index.js";
import { createLogger, type RoutaLogger } from "./logger.js";
import { createTestApplication, type ProjectModules } from "./testing.js";

const withRequest = createMiddleware({
	provides: { tenant: z.string() },
	run: ({ next }) => next({ tenant: "acme" }),
});

/** The modules `.routa/testing.gen.ts` would list for a small project with every scope. */
function projectModules(
	overrides: {
		config?: Record<string, unknown>;
		metadata?: Record<string, unknown>;
		route?: Record<string, unknown>;
	} = {},
): { modules: ProjectModules; built: string[] } {
	const built: string[] = [];
	const route = {
		services: ({
			ctx,
		}: RequestServicesContext<{ tenant: string; services: { clock: { now(): string } } }>) => {
			built.push("orders");
			return { orders: { opened: () => `${ctx.tenant}@${ctx.services.clock.now()}` } };
		},
		get: createRoute({
			responses: { ok: { status: 200, schema: z.string() } },
			run: ({ ctx }) => ({
				type: "ok",
				data: (
					ctx as unknown as { services: { orders: { opened(): string } } }
				).services.orders.opened(),
			}),
		}),
		post: createRoute({
			services: () => {
				built.push("checkout");
				return { checkout: { total: () => "production total" } };
			},
			responses: { ok: { status: 200, schema: z.string() } },
			run: ({ ctx }) => ({
				type: "ok",
				data: (
					ctx as unknown as { services: { checkout: { total(): string } } }
				).services.checkout.total(),
			}),
		}),
		...overrides.route,
	};
	const modules: ProjectModules = {
		".routa/routes.gen.ts": () =>
			Promise.resolve({
				routaApplicationServices: ["clock"],
				routaRoutes: [
					{
						file: "src/routes/orders/route.ts",
						path: "/orders",
						methods: ["GET", "POST"],
						middleware: [{ file: "src/middleware.ts", name: "withRequest" }],
						methodMiddleware: {},
						services: {
							routeFile: { names: ["orders"] },
							methods: { post: { names: ["checkout"] } },
						},
					},
				],
				...overrides.metadata,
			}),
		"src/routa.ts": () =>
			Promise.resolve({
				default: {
					logger: false,
					services: () => {
						built.push("clock");
						return { clock: { now: () => "noon" } };
					},
					...overrides.config,
				},
			}),
		"src/middleware.ts": () => Promise.resolve({ withRequest }),
		"src/routes/orders/route.ts": () => Promise.resolve({ default: route }),
	};

	return { modules, built };
}

describe("createTestApplication", () => {
	it("serves the project's routes in memory with its original factories", async () => {
		const { modules, built } = projectModules();
		const app = await createTestApplication(modules);

		expect(await (await app.request("/orders")).json()).toBe("acme@noon");
		expect(await (await app.request(new URL("http://example.test/orders"))).json()).toBe(
			"acme@noon",
		);
		expect(
			await (
				await app.request(new Request("http://example.test/orders"), { method: "POST" })
			).json(),
		).toBe("production total");
		await app.dispose();
		expect(Object.isFrozen(app)).toBe(true);
		expect(built).toEqual(["clock", "orders", "orders", "orders", "checkout"]);
	});

	it("runs each replacement instead of its scope's original factory", async () => {
		const { modules, built } = projectModules();
		const app = await createTestApplication(modules, {
			services: () => ({ clock: { now: () => "test noon" } }),
			routes: {
				"/orders": {
					methods: { post: { services: () => ({ checkout: { total: () => "test total" } }) } },
				},
			},
		});

		expect(await (await app.request("/orders")).json()).toBe("acme@test noon");
		expect(await (await app.request("/orders", { method: "POST" })).json()).toBe("test total");
		await app.dispose();
		expect(built).toEqual(["orders", "orders"]);
	});

	it("runs each scope's factory after the middleware before it", async () => {
		const events: string[] = [];
		const trace = (name: string) =>
			createMiddleware({
				run: ({ next }) => {
					events.push(name);
					return next();
				},
			});
		const project = projectModules({
			route: {
				services: () => {
					events.push("route-file factory");
					return { orders: { opened: () => "" } };
				},
				middleware: [trace("route-file middleware")],
				post: createRoute({
					services: () => {
						events.push("method factory");
						return { checkout: { total: () => "" } };
					},
					middleware: [trace("method middleware")],
					responses: { ok: { status: 200, schema: z.string() } },
					run: () => {
						events.push("handler");
						return { type: "ok", data: "" };
					},
				}),
			},
		});
		const modules: ProjectModules = {
			...project.modules,
			"src/middleware.ts": () => Promise.resolve({ withRequest: trace("filesystem middleware") }),
		};
		const app = await createTestApplication(modules);

		expect((await app.request("/orders", { method: "POST" })).status).toBe(200);
		await app.dispose();
		expect(events).toEqual([
			"filesystem middleware",
			"route-file factory",
			"route-file middleware",
			"method factory",
			"method middleware",
			"handler",
		]);
	});

	it("reads a lone factory as the application services replacement", async () => {
		const { modules, built } = projectModules();
		const app = await createTestApplication(modules, () => ({
			clock: { now: () => "shorthand" },
		}));

		expect(await (await app.request("/orders")).json()).toBe("acme@shorthand");
		await app.dispose();
		expect(built).toEqual(["orders"]);
	});

	it("checks a replacement's mapping against the scope's declared names", async () => {
		const { modules } = projectModules();
		const app = await createTestApplication(modules, {
			routes: { "/orders": { services: () => ({ orders: {}, extra: {} }) } },
		});
		const response = await app.request("/orders");

		expect(response.status).toBe(500);
		await app.dispose();
		await expect(createTestApplication(modules, () => ({}))).rejects.toThrow(
			'The application services factory must return exactly the declared services ("clock"): missing "clock".',
		);
	});

	it("rejects options and replacement entries it cannot read", async () => {
		const { modules, built } = projectModules();
		const factory = () => ({});

		for (const options of [null, [], "services"]) {
			await expect(createTestApplication(modules, options as never)).rejects.toThrow(
				"createTestApp() expects an application services factory or { services, routes }.",
			);
		}

		await expect(
			createTestApplication(modules, { routes: { "/orders": "services" } } as never),
		).rejects.toThrow('The replacement at routes["/orders"] must be an object.');
		for (const routes of [[], 5]) {
			await expect(createTestApplication(modules, { routes } as never)).rejects.toThrow(
				"The replacement at routes must be an object.",
			);
		}
		await expect(
			createTestApplication(modules, { routes: { "/orders": { methods: [] } } } as never),
		).rejects.toThrow('The replacement at routes["/orders"].methods must be an object.');
		await expect(
			createTestApplication(modules, {
				routes: { "/orders": { methods: { post: { services: factory, extra: 1 } } } },
			} as never),
		).rejects.toThrow(
			'The replacement at routes["/orders"].methods.post accepts only services, received "extra".',
		);
		await expect(
			createTestApplication(modules, {
				routes: { "/orders": { methods: { POST: { services: factory } } } },
			}),
		).rejects.toThrow(
			"Cannot replace services for POST /orders: the route file declares no such method.",
		);
		await expect(
			createTestApplication(modules, { routes: { "/orders": { services: "orders" } } }),
		).rejects.toThrow("The replacement services for route file /orders must be a factory.");
		expect(built).toEqual([]);
	});

	it("types a lone factory's context and rejects a malformed request instead of throwing", async () => {
		const { modules } = projectModules();
		const app = await createTestApplication(modules, ({ onCleanup, logger }) => {
			onCleanup(() => logger.info("clock.released", "Clock released."));
			return { clock: { now: () => "test noon" } };
		});
		const response = app.request("http://[invalid");

		expect(response).toBeInstanceOf(Promise);
		await expect(response).rejects.toThrow();
		await app.dispose();
	});

	it("rejects an application replacement when the project declares no application services", async () => {
		const { modules } = projectModules({
			metadata: { routaApplicationServices: undefined, routaRoutes: [] },
			config: { services: undefined },
		});

		await expect(createTestApplication(modules, () => ({}))).rejects.toThrow(
			"Cannot replace services for the application: it declares none.",
		);
	});

	it("reports where the project and its generated metadata disagree", async () => {
		const cases: Array<[Parameters<typeof projectModules>[0], string]> = [
			[
				{ config: { services: undefined } },
				".routa/routes.gen.ts declares application services, but src/routa.ts configures none. Run routa generate.",
			],
			[
				{ config: { services: { clock: {} } } },
				"src/routa.ts configures services that are not a factory. Declare services in the createRouta object with defineServices<Contract>().",
			],
			[
				{ metadata: { routaApplicationServices: undefined } },
				"src/routa.ts configures services that routa generate could not read from source, so Routa cannot check them.",
			],
			[
				{ route: { services: "orders" } },
				"src/routes/orders/route.ts configures route-file services that are not a factory.",
			],
			[
				{ route: { post: undefined } },
				"Route file src/routes/orders/route.ts is missing POST contract.",
			],
		];

		for (const [overrides, message] of cases) {
			await expect(createTestApplication(projectModules(overrides).modules)).rejects.toThrow(
				message,
			);
		}

		const { modules } = projectModules();
		await expect(
			createTestApplication({
				...modules,
				"src/routes/orders/route.ts": () => Promise.resolve({}),
			}),
		).rejects.toThrow(
			"Route file src/routes/orders/route.ts does not export a default route config.",
		);
		await expect(
			createTestApplication({
				...modules,
				"src/middleware.ts": () => Promise.resolve({ withRequest: {} }),
			}),
		).rejects.toThrow("Middleware withRequest was not exported by src/middleware.ts.");
	});

	it("applies the project's logger, lifecycle headers, and response validation settings", async () => {
		const events: string[] = [];
		const logger = createLogger({ sink: (event) => events.push(event.event) });
		const { modules } = projectModules({
			config: { logger, lifecycleHeaders: false, responseValidation: "always" },
			// Older generators wrote no middleware fields, so the chain comes from the route file.
			metadata: {
				routaRoutes: [
					{
						file: "src/routes/orders/route.ts",
						path: "/orders",
						methods: ["GET"],
						services: { routeFile: { names: ["orders"] } },
					},
				],
			},
			route: {
				middleware: [withRequest],
				post: undefined,
				get: createRoute({
					responses: { ok: { status: 200, schema: z.string() } },
					run: () => ({ type: "ok", data: 1 as unknown as string }),
				}),
			},
		});
		const app = await createTestApplication(modules);

		expect((await app.request("/orders")).status).toBe(500);
		await app.dispose();
		expect(events).toContain("http.response.prepared");
	});

	it("reports a module the generated list leaves out", async () => {
		const { modules } = projectModules();
		const { "src/middleware.ts": _middleware, ...withoutMiddleware } = modules;

		await expect(createTestApplication(withoutMiddleware)).rejects.toThrow(
			".routa/testing.gen.ts does not list src/middleware.ts. Run routa generate.",
		);
	});
});

describe("project logger configuration", () => {
	it("LOG-AC-01 refuses a src/routa.ts logger createLogger did not create", async () => {
		const handWritten = { info: () => undefined, child: () => handWritten };
		const { modules, built } = projectModules({ config: { logger: handWritten } });

		await expect(createTestApplication(modules)).rejects.toThrow(
			new TypeError(
				"src/routa.ts configures a logger that createLogger did not create. Routa accepts only loggers from createLogger, so redaction runs before any output. Forward events to your backend from a sink instead: logger: createLogger({ sink: (event) => backend.write(event) }). Set logger: false to turn logging off.",
			),
		);
		expect(built).toEqual([]);
	});

	it("LOG-AC-01 reads the src/routa.ts logger once, so the logger it checked is the one used", async () => {
		const events: string[] = [];
		const checked = createLogger({ sink: (event) => events.push(event.event) });
		const swapped = { info: vi.fn(), child: () => swapped };
		const config = { services: () => ({ clock: { now: () => "noon" } }) };
		const read = vi.fn((): unknown => (read.mock.calls.length === 1 ? checked : swapped));
		Object.defineProperty(config, "logger", { enumerable: true, get: read });
		const { modules } = projectModules();

		const app = await createTestApplication({
			...modules,
			"src/routa.ts": () => Promise.resolve({ default: config }),
		});
		await app.request("/orders");
		await app.dispose();

		expect(read).toHaveBeenCalledTimes(1);
		expect(events).toEqual(["http.response.prepared"]);
		expect(swapped.info).not.toHaveBeenCalled();
	});

	it("LOG-AC-02 writes JSON console lines at info when src/routa.ts sets no logger", async () => {
		const consoleLog = vi.spyOn(console, "log").mockImplementation(() => undefined);
		const { modules } = projectModules({
			config: {
				logger: undefined,
				services: ({ logger }: { logger: RoutaLogger }) => {
					logger.debug("clock.debug", "Below info.");
					logger.info("clock.ready", "Clock ready.", { apiKey: "k_1", zone: "UTC" });
					return { clock: { now: () => "noon" } };
				},
			},
		});

		try {
			const app = await createTestApplication(modules);
			await app.dispose();
			const lines = consoleLog.mock.calls.map(([line]) => JSON.parse(String(line)));

			expect(lines.filter((line) => line.event.startsWith("clock."))).toEqual([
				{
					timestamp: expect.any(String),
					level: "info",
					event: "clock.ready",
					message: "Clock ready.",
					data: { apiKey: "[Redacted]", zone: "UTC" },
				},
			]);
		} finally {
			consoleLog.mockRestore();
		}
	});

	it("LOG-AC-02 gives a disabled application a no-op ctx.logger without changing a shared logger", async () => {
		const events: string[] = [];
		// A logger a project would import from its own module, in src/routa.ts and in services.
		const shared = createLogger({ sink: (event) => events.push(event.event) });
		const route = {
			get: createRoute({
				responses: { ok: { status: 200, schema: z.boolean() } },
				run: ({ ctx }) => {
					ctx.logger.info("route.request_logger", "Through ctx.logger.");
					shared.info("route.shared_logger", "Through the imported logger.");
					return { type: "ok", data: ctx.logger.isLevelEnabled("fatal") };
				},
			}),
		};
		const enabled = await createTestApplication(
			projectModules({ config: { logger: shared }, route }).modules,
		);
		const disabled = await createTestApplication(
			projectModules({ config: { logger: false }, route }).modules,
		);

		expect(await (await disabled.request("/orders")).json()).toBe(false);
		expect(events).toEqual(["route.shared_logger"]);
		expect(await (await enabled.request("/orders")).json()).toBe(true);
		expect(events).toEqual([
			"route.shared_logger",
			"route.request_logger",
			"route.shared_logger",
			"http.response.prepared",
		]);
		await enabled.dispose();
		await disabled.dispose();
	});
});

describe("project request identity", () => {
	const route = {
		get: createRoute({
			responses: { ok: { status: 200, schema: z.object({ requestId: z.string() }) } },
			run: ({ ctx }) => ({ type: "ok", data: { requestId: ctx.requestId } }),
		}),
	};

	it("LOG-AC-07 identifies requests with logging off and echoes the configured correlation header", async () => {
		const { modules } = projectModules({
			config: { logger: false, correlation: { header: "X-Trace-Ref" } },
			metadata: { routaCorrelationHeader: "x-trace-ref" },
			route,
		});
		const app = await createTestApplication(modules);

		const response = await app.request("/orders", { headers: { "x-trace-ref": "trace-1" } });

		expect(await response.json()).toEqual({ requestId: response.headers.get("x-request-id") });
		expect(response.headers.get("x-trace-ref")).toBe("trace-1");
		await app.dispose();
	});

	it("LOG-AC-11 refuses correlation that src/routa.ts and the generated metadata disagree on", async () => {
		for (const [config, metadata, message] of [
			[
				{ correlation: true },
				{},
				"src/routa.ts reads correlation from x-correlation-id, but .routa/routes.gen.ts declares no correlation header. Write correlation as a literal in the createRouta object, then run routa generate.",
			],
			[
				{},
				{ routaCorrelationHeader: "x-correlation-id" },
				".routa/routes.gen.ts declares correlation header x-correlation-id, but src/routa.ts configures no correlation. Run routa generate.",
			],
			[
				{ correlation: { header: "x-trace-ref" } },
				{ routaCorrelationHeader: "x-correlation-id" },
				"src/routa.ts reads correlation from x-trace-ref, but .routa/routes.gen.ts declares x-correlation-id. Run routa generate.",
			],
		] as const) {
			const { modules, built } = projectModules({ config, metadata });

			await expect(createTestApplication(modules)).rejects.toThrow(message);
			expect(built).toEqual([]);
		}
	});
});
