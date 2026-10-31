import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { run } from "./index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

type TestApp = {
	request: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
	dispose: () => Promise<void>;
};

type TestingModule = {
	createTestApp: (options?: unknown) => Promise<TestApp>;
};

/** Effects a fixture's factories record, shared with the test through `globalThis`. */
type Events = string[];

const clockServices = `import { defineServices } from "@routa-ts/core";

export interface Clock {
\tnow(): string;
}

export interface AppServices {
\tclock: Clock;
}

export const defineAppServices = defineServices<AppServices>();
`;

const productionConfig = `import { createRouta } from "@routa-ts/core";
import { defineAppServices } from "./services.js";

export default createRouta({
\tlogger: false,
\tservices: defineAppServices(({ onCleanup }) => {
\t\tconst events = ((globalThis as { routaEvents?: string[] }).routaEvents ??= []);
\t\tevents.push("production clock built");
\t\tonCleanup(() => events.push("production clock released"));
\t\treturn { clock: { now: () => "production" } };
\t}),
});
`;

const timeRoute = `import { createRoute, createRouteRoot } from "@routa-ts/core";
import { z } from "zod";

export default createRouteRoot("/time")({
\tget: createRoute({
\t\tresponses: { ok: { status: 200, schema: z.object({ now: z.string() }) } },
\t\trun: ({ ctx }) => ({ type: "ok", data: { now: ctx.services.clock.now() } }),
\t}),
});
`;

/** A fake clock and its factory, written in an ordinary test file against the generated types. */
const fakeClock = `import type { Clock } from "../src/services.js";
import type { ServicesFactory } from "../.routa/testing.gen.js";

export class FakeClock implements Clock {
\tnow() {
\t\treturn "fake";
\t}
}

export const testAppServices: ServicesFactory<"application"> = ({ onCleanup }) => {
\tonCleanup(() => {});
\treturn { clock: new FakeClock() };
};
`;

const shorthandTypeChecks = `import { createTestApp, type ServicesFactory } from "../.routa/testing.gen.js";
import { testAppServices } from "./fakes.js";

// Type assertions only; never called.
export async function typeChecks() {
\tconst app = await createTestApp(testAppServices);
\tconst response: Response = await app.request("/time", { method: "GET" });
\tvoid response;
\tawait app.dispose();
\tawait createTestApp();
\tawait createTestApp({ services: testAppServices });
\t// @ts-expect-error A replacement returns its scope's complete contract.
\tawait createTestApp(() => ({}));
\t// @ts-expect-error A replacement returns services with the contract's types.
\tawait createTestApp(() => ({ clock: { now: () => 1 } }));
\t// @ts-expect-error The route file /time declares no services to replace.
\tawait createTestApp({ routes: { "/time": { services: testAppServices } } });
\t// @ts-expect-error Options hold services and routes only.
\tawait createTestApp({ service: testAppServices });
\t// @ts-expect-error ServicesFactory names only scopes that declare services.
\tconst missing: ServicesFactory<"/time"> = testAppServices;
\tvoid missing;
}
`;

const ordersServices = `import { defineServices } from "@routa-ts/core";

export interface Orders {
\topened(): string;
}

export interface OrdersServices {
\torders: Orders;
}

export interface CheckoutServices {
\tcheckout: { total(): string };
}

export const defineOrdersServices = defineServices<OrdersServices>();
export const defineCheckoutServices = defineServices<CheckoutServices>();
`;

const requestMiddleware = `import { createMiddleware } from "@routa-ts/core";
import { z } from "zod";

export const withRequest = createMiddleware({
\tprovides: { requestId: z.string() },
\trun: ({ next }) => next({ requestId: "req-1" }),
});
`;

/** Each production factory records when it builds and releases, so a test sees which ran. */
const ordersRoute = `import { createRoute, createRouteRoot } from "@routa-ts/core";
import { z } from "zod";
import { defineCheckoutServices, defineOrdersServices } from "../../orders/services.js";

const events = () => ((globalThis as { routaEvents?: string[] }).routaEvents ??= []);

export default createRouteRoot("/orders")({
\tservices: defineOrdersServices(({ ctx, onCleanup }) => {
\t\tevents().push("production orders built");
\t\tonCleanup(() => events().push("production orders released"));
\t\tconst opened = \`\${ctx.requestId}@\${ctx.services.clock.now()}\`;
\t\treturn { orders: { opened: () => opened } };
\t}),
\tget: createRoute({
\t\tresponses: { ok: { status: 200, schema: z.object({ opened: z.string() }) } },
\t\trun: ({ ctx }) => ({ type: "ok", data: { opened: ctx.services.orders.opened() } }),
\t}),
\tpost: createRoute({
\t\tservices: defineCheckoutServices(({ ctx, onCleanup }) => {
\t\t\tevents().push("production checkout built");
\t\t\tonCleanup(() => events().push("production checkout released"));
\t\t\tconst total = \`total for \${ctx.services.orders.opened()}\`;
\t\t\treturn { checkout: { total: () => total } };
\t\t}),
\t\tresponses: { ok: { status: 200, schema: z.object({ total: z.string() }) } },
\t\trun: ({ ctx }) => ({ type: "ok", data: { total: ctx.services.checkout.total() } }),
\t}),
});
`;

/** Test doubles in an ordinary file: an object, a class, and factories typed by scope. */
const ordersFakes = `import type { Orders } from "../src/orders/services.js";
import type { ServicesFactory } from "../.routa/testing.gen.js";

const events = () => ((globalThis as { routaEvents?: string[] }).routaEvents ??= []);

export class FakeOrders implements Orders {
\tconstructor(private readonly by: string) {}

\topened() {
\t\treturn \`fake opened by \${this.by}\`;
\t}
}

export const testAppServices: ServicesFactory<"application"> = ({ onCleanup }) => {
\tevents().push("test clock built");
\tonCleanup(() => events().push("test clock released"));
\treturn { clock: { now: () => "test noon" } };
};

export const testOrdersServices: ServicesFactory<"/orders"> = ({ ctx, onCleanup }) => {
\tevents().push("test orders built");
\tonCleanup(() => events().push("test orders released"));
\treturn { orders: new FakeOrders(\`\${ctx.requestId}@\${ctx.services.clock.now()}\`) };
};

export const testCheckoutServices: ServicesFactory<"POST /orders"> = ({ ctx, onCleanup }) => {
\tevents().push("test checkout built");
\tonCleanup(() => events().push("test checkout released"));
\tconst checkout = { total: () => \`test total for \${ctx.services.orders.opened()}\` };
\treturn { checkout };
};
`;

const scopedTypeChecks = `import { createTestApp, type ServicesFactory } from "../.routa/testing.gen.js";
import { testAppServices, testCheckoutServices, testOrdersServices } from "./fakes.js";

// Type assertions only; never called.
export async function typeChecks() {
\tawait createTestApp({
\t\tservices: testAppServices,
\t\troutes: { "/orders": { services: testOrdersServices, methods: { post: { services: testCheckoutServices } } } },
\t});
\tawait createTestApp({ routes: { "/orders": { methods: { post: { services: testCheckoutServices } } } } });
\t// @ts-expect-error No route file declares /missing.
\tawait createTestApp({ routes: { "/missing": { services: testOrdersServices } } });
\t// @ts-expect-error GET /orders declares no services to replace.
\tawait createTestApp({ routes: { "/orders": { methods: { get: { services: testCheckoutServices } } } } });
\t// @ts-expect-error The route file /time declares no services to replace.
\tawait createTestApp({ routes: { "/time": { services: testOrdersServices } } });
\t// @ts-expect-error Each scope takes its own contract's factory.
\tawait createTestApp({ routes: { "/orders": { services: testCheckoutServices } } });
\t// @ts-expect-error A replacement returns its scope's complete contract.
\tawait createTestApp({ routes: { "/orders": { services: () => ({}) } } });
\tconst ordersFactory: ServicesFactory<"/orders"> = ({ ctx }) => {
\t\t// @ts-expect-error A route-file factory cannot read its own services.
\t\tvoid ctx.services.orders;
\t\treturn { orders: { opened: () => ctx.requestId } };
\t};
\tvoid ordersFactory;
\tconst checkoutFactory: ServicesFactory<"POST /orders"> = ({ ctx }) => ({
\t\tcheckout: { total: () => ctx.services.orders.opened() },
\t});
\tvoid checkoutFactory;
}
`;

/** A project with application services, filesystem middleware, and request-scoped services. */
function scopedProject(files: Record<string, string> = {}): string {
	return testingProject({
		"src/services.ts": clockServices,
		"src/routa.ts": productionConfig,
		"src/routes/middleware.ts": requestMiddleware,
		"src/orders/services.ts": ordersServices,
		"src/routes/orders/route.ts": ordersRoute,
		"src/routes/time/route.ts": timeRoute,
		"test/fakes.ts": ordersFakes,
		"test/type-checks.ts": scopedTypeChecks,
		...files,
	});
}

describe("generated test applications", () => {
	it("replaces the application services factory with the shorthand form", async () => {
		const cwd = testingProject({
			"src/services.ts": clockServices,
			"src/routa.ts": productionConfig,
			"src/routes/time/route.ts": timeRoute,
			"test/fakes.ts": fakeClock,
			"test/type-checks.ts": shorthandTypeChecks,
		});
		expectPassed(await run(["check"], { cwd }));
		const generated = readFileSync(join(cwd, ".routa/testing.gen.ts"), "utf8");
		expectPassed(await run(["generate"], { cwd }));
		expect(readFileSync(join(cwd, ".routa/testing.gen.ts"), "utf8")).toBe(generated);
		const events = resetEvents();
		const { createTestApp } = await importTesting(cwd);

		expect(events).toEqual([]);

		const app = await createTestApp(
			({ onCleanup }: { onCleanup: (callback: () => unknown) => void }) => {
				events.push("test clock built");
				onCleanup(() => events.push("test clock released"));
				return { clock: { now: () => "test" } };
			},
		);
		const response = await app.request("/time");

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ now: "test" });
		await app.dispose();
		expect(events).toEqual(["test clock built", "test clock released"]);
	}, 30_000);

	it("replaces route-file and method services while omitted scopes consume the replacements", async () => {
		const cwd = scopedProject();
		expectPassed(await run(["check"], { cwd }));
		const events = resetEvents();
		const { createTestApp } = await importTesting(cwd);
		const fakes = (await import(pathToFileURL(join(cwd, "test/fakes.ts")).href)) as Record<
			string,
			unknown
		>;

		// The method scope is replaced; the original route-file factory runs with the test clock.
		const methodOnly = await createTestApp({
			services: fakes.testAppServices,
			routes: { "/orders": { methods: { post: { services: fakes.testCheckoutServices } } } },
		});
		const methodOnlyResponse = await methodOnly.request("/orders", { method: "POST" });

		expect(await methodOnlyResponse.json()).toEqual({ total: "test total for req-1@test noon" });
		await methodOnly.dispose();
		expect(events.splice(0)).toEqual([
			"test clock built",
			"production orders built",
			"test checkout built",
			"test checkout released",
			"production orders released",
			"test clock released",
		]);

		// The route-file scope is replaced; the original method factory consumes the fake orders.
		const routeFileOnly = await createTestApp({
			routes: { "/orders": { services: fakes.testOrdersServices } },
		});
		const routeFileResponse = await routeFileOnly.request("/orders", { method: "POST" });

		expect(await routeFileResponse.json()).toEqual({
			total: "total for fake opened by req-1@production",
		});
		await routeFileOnly.dispose();
		expect(events.splice(0)).toEqual([
			"production clock built",
			"test orders built",
			"production checkout built",
			"production checkout released",
			"test orders released",
			"production clock released",
		]);
	}, 30_000);

	it("rejects replacements for scopes that declare no services before any factory runs", async () => {
		const cwd = scopedProject();
		expectPassed(await run(["generate"], { cwd }));
		const events = resetEvents();
		const { createTestApp } = await importTesting(cwd);
		const factory = () => ({});

		await expect(createTestApp({ routes: { "/missing": { services: factory } } })).rejects.toThrow(
			"Cannot replace services for /missing: no route file declares it.",
		);
		await expect(createTestApp({ routes: { "/time": { services: factory } } })).rejects.toThrow(
			"Cannot replace services for route file /time: it declares none.",
		);
		await expect(
			createTestApp({ routes: { "/orders": { methods: { get: { services: factory } } } } }),
		).rejects.toThrow("Cannot replace services for GET /orders: it declares none.");
		await expect(
			createTestApp({ routes: { "/orders": { methods: { put: { services: factory } } } } }),
		).rejects.toThrow(
			"Cannot replace services for PUT /orders: the route file declares no such method.",
		);
		await expect(createTestApp({ routes: { "/orders": { service: factory } } })).rejects.toThrow(
			'The replacement at routes["/orders"] accepts only services and methods, received "service".',
		);
		await expect(createTestApp({ services: { clock: {} } })).rejects.toThrow(
			"The replacement services for the application must be a factory.",
		);
		await expect(createTestApp({ service: factory })).rejects.toThrow(
			'createTestApp() accepts only services and routes, received "service".',
		);
		expect(events).toEqual([]);
	}, 30_000);

	it("types a separately declared production factory with the generated contract type", async () => {
		const cwd = scopedProject({
			"src/reports/services.ts": `import { defineServices } from "@routa-ts/core";
import type { ServicesFactory } from "../../.routa/testing.gen.js";

export interface ReportsServices {
\treports: { title(): string };
}

export const defineReportsServices = defineServices<ReportsServices>();

// Declared apart from its route, so it names its scope's factory type.
export const reportsServices: ServicesFactory<"/reports"> = ({ ctx }) => ({
\treports: { title: () => \`weekly for \${ctx.requestId} at \${ctx.services.clock.now()}\` },
});
`,
			"src/routes/reports/route.ts": `import { createRoute, createRouteRoot } from "@routa-ts/core";
import { z } from "zod";
import { defineReportsServices, reportsServices } from "../../reports/services.js";

export default createRouteRoot("/reports")({
\tservices: defineReportsServices(reportsServices),
\tget: createRoute({
\t\tresponses: { ok: { status: 200, schema: z.string() } },
\t\trun: ({ ctx }) => ({ type: "ok", data: ctx.services.reports.title() }),
\t}),
});
`,
		});
		expectPassed(await run(["check"], { cwd }));
		resetEvents();
		const { createTestApp } = await importTesting(cwd);
		const app = await createTestApp();

		expect(await (await app.request("/reports")).json()).toBe("weekly for req-1 at production");
		await app.dispose();
	}, 30_000);

	describe("lifecycle", () => {
		type OnCleanup = (callback: () => unknown) => void;
		type Factory = (context: { onCleanup: OnCleanup }) => unknown;
		let createTestApp: TestingModule["createTestApp"];
		let events: Events;

		beforeAll(async () => {
			const cwd = scopedProject();
			expectPassed(await run(["generate"], { cwd }));
			({ createTestApp } = await importTesting(cwd));
		}, 30_000);

		beforeEach(() => {
			events = resetEvents();
		});

		/** An application services factory that records under a label and owns one cleanup. */
		const clock =
			(label: string, release: () => unknown = () => events.push(`${label} released`)): Factory =>
			({ onCleanup }) => {
				events.push(`${label} built`);
				onCleanup(release);
				return { clock: { now: () => label } };
			};

		it("builds isolated instances without a listener", async () => {
			const listeners = () =>
				process.getActiveResourcesInfo().filter((resource) => resource === "TCPServerWrap").length;
			const before = listeners();
			const [first, second] = await Promise.all([
				createTestApp(clock("first")),
				createTestApp(clock("second")),
			]);

			expect(listeners()).toBe(before);
			expect(await (await first.request("/time")).json()).toEqual({ now: "first" });
			expect(await (await second.request("/time")).json()).toEqual({ now: "second" });
			await first.dispose();
			expect(await (await second.request("/time")).json()).toEqual({ now: "second" });
			await second.dispose();
			expect(events).toEqual(["first built", "second built", "first released", "second released"]);
		});

		it("rejects with the factory error after releasing the cleanup it registered", async () => {
			const failure = new Error("clock unavailable");

			await expect(
				createTestApp(({ onCleanup }: { onCleanup: OnCleanup }) => {
					events.push("test clock acquired");
					onCleanup(() => {
						events.push("test clock released");
						throw new Error("release failed too");
					});
					throw failure;
				}),
			).rejects.toBe(failure);
			expect(events).toEqual(["test clock acquired", "test clock released"]);
		});

		it("settles a request after its request cleanup", async () => {
			const app = await createTestApp({
				services: clock("test clock"),
				routes: {
					"/orders": {
						methods: {
							post: {
								services: ({ onCleanup }: { onCleanup: OnCleanup }) => {
									onCleanup(() => events.push("test checkout released"));
									return { checkout: { total: () => "1" } };
								},
							},
						},
					},
				},
			});
			const response = await app.request(
				new Request("http://example.test/orders", { method: "POST" }),
			);
			events.push(`response ${response.status}`);

			expect(await response.json()).toEqual({ total: "1" });
			await app.dispose();
			expect(events).toEqual([
				"test clock built",
				"production orders built",
				"test checkout released",
				"production orders released",
				"response 200",
				"test clock released",
			]);
		});

		it("drains accepted requests, rejects new ones, then releases application services", async () => {
			let finish = () => {};
			const gate = new Promise<void>((resolve) => {
				finish = resolve;
			});
			const app = await createTestApp({
				services: clock("test clock"),
				routes: {
					"/orders": {
						services: async ({ onCleanup }: { onCleanup: OnCleanup }) => {
							events.push("request started");
							await gate;
							onCleanup(() => events.push("request released"));
							return { orders: { opened: () => "slow" } };
						},
					},
				},
			});
			const accepted = app.request("/orders");
			await Promise.resolve();
			const disposal = app.dispose();
			let disposed = false;
			void disposal.then(() => {
				disposed = true;
			});

			await expect(app.request("/time")).rejects.toThrow(
				"This Routa application is being disposed, so it accepts no new requests.",
			);
			await new Promise((resolve) => setTimeout(resolve, 20));
			expect(disposed).toBe(false);
			expect(events).toEqual(["test clock built", "request started"]);

			finish();
			expect(await (await accepted).json()).toEqual({ opened: "slow" });
			await disposal;
			expect(events).toEqual([
				"test clock built",
				"request started",
				"request released",
				"test clock released",
			]);
		});

		it("shares one rejected outcome across repeated and concurrent disposal", async () => {
			const app = await createTestApp(({ onCleanup }: { onCleanup: OnCleanup }) => {
				onCleanup(() => events.push("first callback released"));
				onCleanup(() => {
					throw new Error("pool did not close");
				});
				onCleanup(() => events.push("last callback released"));
				return { clock: { now: () => "test" } };
			});
			const first = app.dispose();
			const concurrent = app.dispose();
			const firstError = await first.catch((error: unknown) => error);
			const repeatedError = await app.dispose().catch((error: unknown) => error);

			expect(concurrent).toBe(first);
			expect(repeatedError).toBe(firstError);
			expect(firstError).toBeInstanceOf(AggregateError);
			expect((firstError as AggregateError).errors.map((error: Error) => error.message)).toEqual([
				"pool did not close",
			]);
			expect(events).toEqual(["last callback released", "first callback released"]);
		});
	});
});

function resetEvents(): Events {
	const events: Events = [];
	(globalThis as { routaEvents?: Events }).routaEvents = events;
	return events;
}

async function importTesting(cwd: string): Promise<TestingModule> {
	return (await import(pathToFileURL(join(cwd, ".routa/testing.gen.ts")).href)) as TestingModule;
}

function expectPassed(result: {
	code: number;
	stdout?: string | undefined;
	stderr?: string | undefined;
}) {
	if (result.code !== 0 || result.stderr) {
		throw new Error(`routa failed:\n${result.stdout ?? ""}${result.stderr ?? ""}`);
	}

	expect(result.code).toBe(0);
}

/** A Routa project whose TypeScript resolves `@routa-ts/core` to this checkout's source. */
function testingProject(files: Record<string, string>): string {
	const cwd = mkdtempSync(join(tmpdir(), "routa-testing-"));
	mkdirSync(join(cwd, "node_modules/@routa-ts"), { recursive: true });
	symlinkSync(join(repoRoot, "packages/core"), join(cwd, "node_modules/@routa-ts/core"), "dir");
	symlinkSync(
		join(repoRoot, "packages/core/node_modules/zod"),
		join(cwd, "node_modules/zod"),
		"dir",
	);
	const allFiles: Record<string, string> = {
		"package.json": JSON.stringify({ type: "module" }),
		"tsconfig.json": JSON.stringify({
			compilerOptions: {
				target: "ES2022",
				module: "NodeNext",
				moduleResolution: "NodeNext",
				strict: true,
				skipLibCheck: true,
				noEmit: true,
				paths: {
					"@routa-ts/core": [join(repoRoot, "packages/core/src/index.ts")],
					"@routa-ts/core/hono": [join(repoRoot, "packages/core/src/hono.ts")],
					"@routa-ts/core/testing": [join(repoRoot, "packages/core/src/testing.ts")],
					zod: [join(repoRoot, "packages/core/node_modules/zod/index.d.ts")],
				},
			},
			include: ["src/**/*.ts", "test/**/*.ts", ".routa/**/*.ts"],
		}),
		...files,
	};

	for (const [file, content] of Object.entries(allFiles)) {
		mkdirSync(dirname(join(cwd, file)), { recursive: true });
		writeFileSync(join(cwd, file), content);
	}

	return cwd;
}
