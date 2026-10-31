import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { createMiddleware, createRoute, type RequestServicesContext } from "./index.js";
import { createLogger } from "./logger.js";
import { createTestApplication, type ProjectModules } from "./testing.js";

const withRequest = createMiddleware({
	provides: { requestId: z.string() },
	run: ({ next }) => next({ requestId: "req-1" }),
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
		}: RequestServicesContext<{ requestId: string; services: { clock: { now(): string } } }>) => {
			built.push("orders");
			return { orders: { opened: () => `${ctx.requestId}@${ctx.services.clock.now()}` } };
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

		expect(await (await app.request("/orders")).json()).toBe("req-1@noon");
		expect(await (await app.request(new URL("http://example.test/orders"))).json()).toBe(
			"req-1@noon",
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

		expect(await (await app.request("/orders")).json()).toBe("req-1@test noon");
		expect(await (await app.request("/orders", { method: "POST" })).json()).toBe("test total");
		await app.dispose();
		expect(built).toEqual(["orders", "orders"]);
	});

	it("reads a lone factory as the application services replacement", async () => {
		const { modules, built } = projectModules();
		const app = await createTestApplication(modules, () => ({
			clock: { now: () => "shorthand" },
		}));

		expect(await (await app.request("/orders")).json()).toBe("req-1@shorthand");
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
		expect(events).toContain("http.request");
	});

	it("reports a module the generated list leaves out", async () => {
		const { modules } = projectModules();
		const { "src/middleware.ts": _middleware, ...withoutMiddleware } = modules;

		await expect(createTestApplication(withoutMiddleware)).rejects.toThrow(
			".routa/testing.gen.ts does not list src/middleware.ts. Run routa generate.",
		);
	});
});
