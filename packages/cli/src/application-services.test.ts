import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { run } from "./index.js";
import { generateOpenApi } from "./openapi.js";
import { validateProject } from "./project.js";
import { createProjectApplication, startRuntime } from "./runtime.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const clockContract = `import { defineServices } from "@routa-ts/core";

export interface Clock {
\tnow(): string;
}

export interface AppServices {
\tclock: Clock;
}

export const defineAppServices = defineServices<AppServices>();
`;

const timeRoute = `import { createRoute, createRouteRoot } from "@routa-ts/core";
import { z } from "zod";

export default createRouteRoot("/time")({
\tget: createRoute({
\t\tresponses: { ok: { status: 200, schema: z.object({ now: z.string() }) } },
\t\trun: ({ ctx }) => {
\t\t\t// Type assertions only; never called.
\t\t\tconst typeChecks = () => {
\t\t\t\t// @ts-expect-error Service references are readonly.
\t\t\t\tctx.services.clock = { now: () => "replaced" };
\t\t\t\t// @ts-expect-error Consumers see the declared interface, not the implementation.
\t\t\t\tctx.services.clock.tick();
\t\t\t\t// @ts-expect-error Only declared services exist.
\t\t\t\tvoid ctx.services.orders;
\t\t\t};
\t\t\tvoid typeChecks;
\t\t\treturn { type: "ok", data: { now: ctx.services.clock.now() } };
\t\t},
\t}),
});
`;

describe("application services", () => {
	it("types, generates, and serves services declared with a named helper", async () => {
		const cwd = servicesProject({
			"src/services.ts": clockContract,
			"src/routa.ts": `import { createRouta } from "@routa-ts/core";
import { defineAppServices } from "./services.js";

class FixedClock {
\tnow() {
\t\treturn "2030-01-01T00:00:00.000Z";
\t}

\ttick() {}
}

export default createRouta({
\tservices: defineAppServices(() => ({ clock: new FixedClock() })),
});
`,
			"src/routes/time/route.ts": timeRoute,
		});

		const check = await run(["check"], { cwd });

		expectPassed(check);
		expect(check.code).toBe(0);
		const generated = readFileSync(join(cwd, ".routa/routes.gen.ts"), "utf8");
		expect(generated).toContain(
			'export const routaApplicationServices = [\n\t"clock"\n] as const;',
		);
		expect(generated).toContain(
			'export type RoutaApplicationServices = import("../src/services.js").AppServices;',
		);
		expect(generated).toContain("\t\tapplicationServices: RoutaApplicationServices;\n");

		const { application } = await createProjectApplication(cwd, cwd, "dev");
		const response = await application.fetch(new Request("http://localhost/time"));

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ now: "2030-01-01T00:00:00.000Z" });
		await application.dispose();
	}, 30_000);
});

const ordersContract = `import { defineServices } from "@routa-ts/core";

export interface Clock {
\tnow(): string;
}

export interface OrderStore {
\tcount(): number;
}

export interface AppServices {
\torders: OrderStore;
\tclock: Clock;
}

export const defineAppServices = defineServices<AppServices>();
`;

const ordersRoute = `import { createRoute, createRouteRoot } from "@routa-ts/core";
import { z } from "zod";

export default createRouteRoot("/orders")({
\tget: createRoute({
\t\tresponses: { ok: { status: 200, schema: z.object({ count: z.number(), at: z.string() }) } },
\t\trun: ({ ctx }) => ({
\t\t\ttype: "ok",
\t\t\tdata: { count: ctx.services.orders.count(), at: ctx.services.clock.now() },
\t\t}),
\t}),
});
`;

describe("application service declarations", () => {
	it("follows imported factories, helpers, and re-exported contracts", async () => {
		const cwd = servicesProject({
			"src/contracts/index.ts": 'export * from "./app.js";\n',
			"src/contracts/app.ts": ordersContract,
			"src/services.ts": `import { defineAppServices } from "./contracts/index.js";

class MemoryOrders {
\tconstructor(private readonly clock: { now(): string }) {}

\tcount() {
\t\treturn this.clock.now().length;
\t}
}

export const appServices = defineAppServices(async () => {
\tconst clock = { now: () => "2030-01-01" };
\treturn { clock, orders: new MemoryOrders(clock) };
});
`,
			"src/routa.ts": `import { createRouta } from "@routa-ts/core";
import { appServices as services } from "./services.js";

export default createRouta({ services });
`,
			"src/routes/orders/route.ts": ordersRoute,
		});

		const check = await run(["check"], { cwd });

		expectPassed(check);
		const generated = readFileSync(join(cwd, ".routa/routes.gen.ts"), "utf8");
		expect(generated).toContain(
			'export const routaApplicationServices = [\n\t"clock",\n\t"orders"\n] as const;',
		);
		expect(generated).toContain(
			'export type RoutaApplicationServices = import("../src/contracts/app.js").AppServices;',
		);

		const { application } = await createProjectApplication(cwd, cwd, "dev");
		const response = await application.fetch(new Request("http://localhost/orders"));

		expect(await response.json()).toEqual({ count: 10, at: "2030-01-01" });
		await application.dispose();
	}, 30_000);

	it("reads the inline helper form with a contract declared in src/routa.ts", async () => {
		const cwd = servicesProject({
			"src/routa.ts": `import { createRouta, defineServices } from "@routa-ts/core";

export interface AppServices {
\tclock: { now(): string };
}

export default createRouta({
\tservices: defineServices<AppServices>()(() => ({ clock: { now: () => "2030-01-01T00:00:00.000Z" } })),
});
`,
			"src/routes/time/route.ts": timeRoute.replace(
				/\t\t\t\t\/\/ @ts-expect-error Consumers[^\n]*\n[^\n]*\n/,
				"",
			),
		});

		const check = await run(["check"], { cwd });

		expectPassed(check);
		expect(readFileSync(join(cwd, ".routa/routes.gen.ts"), "utf8")).toContain(
			'export type RoutaApplicationServices = import("../src/routa.js").AppServices;',
		);
	}, 30_000);

	it("reads every service of a contract merged across interface declarations", async () => {
		const cwd = servicesProject({
			"src/services.ts": `import { defineServices } from "@routa-ts/core";

export interface AppServices {
\tclock: { now(): string };
}

export interface AppServices {
\tdb: { name: string };
}

export const defineAppServices = defineServices<AppServices>();
`,
			"src/routa.ts": `import { createRouta } from "@routa-ts/core";
import { defineAppServices } from "./services.js";

export default createRouta({
\tservices: defineAppServices(() => ({ clock: { now: () => "" }, db: { name: "orders" } })),
});
`,
			"src/routes/status/route.ts": statusRoute,
		});

		expect((await run(["generate"], { cwd })).code).toBe(0);
		expect(readFileSync(join(cwd, ".routa/routes.gen.ts"), "utf8")).toContain(
			'export const routaApplicationServices = [\n\t"clock",\n\t"db"\n] as const;',
		);

		const { application } = await createProjectApplication(cwd, cwd, "dev");
		await application.dispose();
	});

	it("reports services declarations it cannot follow", () => {
		for (const services of [
			"async () => ({ clock: {} })",
			"makeServices()",
			"defineServices()(() => ({}))",
			"helpers.defineAppServices(() => ({}))",
		]) {
			const cwd = servicesProject({
				"src/routa.ts": `import { createRouta, defineServices } from "@routa-ts/core";

const makeServices = () => async () => ({});
const helpers = { defineAppServices: defineServices<{ clock: string }>() };

export default createRouta({ services: ${services} });
`,
			});

			expect({ services, diagnostics: validateProject(cwd, { write: false }).diagnostics }).toEqual(
				{
					services,
					diagnostics: [
						{
							code: "ROUTA_SERVICES_UNRESOLVED",
							severity: "error",
							message:
								"Application services in src/routa.ts cannot be statically resolved to a service contract.",
							file: "src/routa.ts",
							suggestion:
								"Declare `const defineAppServices = defineServices<AppServices>();` and set `services: defineAppServices(factory)`, or write `services: defineServices<AppServices>()(factory)`. Each binding must be a const declaration or a relative import.",
						},
					],
				},
			);
		}
	});

	it("reports contracts it cannot resolve or reference", () => {
		const cases = [
			[
				"defineServices<{ clock: string }>()",
				"",
				"Service contract { clock: string } is not a named interface or type.",
			],
			["defineServices<Missing>()", "", "Service contract Missing cannot be resolved"],
			[
				"defineServices<AppServices>()",
				"interface AppServices { clock: string }\n",
				"Service contract AppServices in src/routa.ts is not exported, so generated types cannot reference it.",
			],
		] as const;

		for (const [helper, declaration, message] of cases) {
			const cwd = servicesProject({
				"src/routa.ts": `import { createRouta, defineServices } from "@routa-ts/core";

${declaration}export default createRouta({ services: ${helper}(() => ({ clock: "" })) });
`,
			});
			const diagnostics = validateProject(cwd, { write: false }).diagnostics;

			expect(
				diagnostics.map((item) => item.code),
				helper,
			).toEqual(["ROUTA_SERVICES_CONTRACT_UNRESOLVED"]);
			expect(diagnostics[0]?.message).toContain(message);
		}
	});

	it("reports contracts that are not a fixed set of required services", () => {
		const cases = [
			["export interface AppServices { clock?: string }", 'declares service "clock" optional'],
			["export interface AppServices { [name: string]: unknown }", "has an index signature"],
			[
				"interface Base { clock: string }\nexport interface AppServices extends Base { db: string }",
				"extends another type",
			],
			["export type AppServices = Record<string, unknown>;", "is not an object type"],
			[
				'export interface AppServices { ["cl" + "ock"]: string }',
				'has a computed service name `["cl" + "ock"]`',
			],
		] as const;

		for (const [contract, problem] of cases) {
			const cwd = servicesProject({
				"src/routa.ts": `import { createRouta, defineServices } from "@routa-ts/core";

${contract}

export default createRouta({ services: defineServices<AppServices>()(() => ({}) as never) });
`,
			});

			expect({ contract, diagnostics: validateProject(cwd, { write: false }).diagnostics }).toEqual(
				{
					contract,
					diagnostics: [
						{
							code: "ROUTA_SERVICES_CONTRACT_UNSUPPORTED",
							severity: "error",
							message: `Service contract AppServices ${problem}.`,
							file: "src/routa.ts",
							suggestion:
								"Declare each service as a required property with a plain name, directly in an interface or object type, without index signatures or extends.",
						},
					],
				},
			);
		}
	});

	it("keeps plain-import projects free of ctx.services and generated service state", async () => {
		const cwd = servicesProject({
			"src/clock.ts": "export const clock = { now: () => 'plain' };\n",
			"src/routes/time/route.ts": `import { createRoute, createRouteRoot } from "@routa-ts/core";
import { z } from "zod";
import { clock } from "../../clock.js";

export default createRouteRoot("/time")({
\tget: createRoute({
\t\tresponses: { ok: { status: 200, schema: z.object({ now: z.string() }) } },
\t\trun: ({ ctx }) => {
\t\t\t// Type assertions only; never called.
\t\t\tconst typeChecks = () => {
\t\t\t\t// @ts-expect-error No services are configured.
\t\t\t\tvoid ctx.services;
\t\t\t};
\t\t\tvoid typeChecks;
\t\t\treturn { type: "ok", data: { now: clock.now() } };
\t\t},
\t}),
});
`,
		});

		const check = await run(["check"], { cwd });

		expectPassed(check);
		expect(readFileSync(join(cwd, ".routa/routes.gen.ts"), "utf8")).not.toMatch(/services/i);

		const { application } = await createProjectApplication(cwd, cwd, "dev");
		expect(await (await application.fetch(new Request("http://localhost/time"))).json()).toEqual({
			now: "plain",
		});
		await application.dispose();
	}, 30_000);

	it("generates without executing application modules or factories", async () => {
		const sentinel = join(mkdtempSync(join(tmpdir(), "routa-services-sentinel-")), "executed");
		const sideEffect = `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(sentinel)}, "module");\n`;
		const cwd = servicesProject({
			"src/services.ts": `${sideEffect}${clockContract}`,
			"src/routa.ts": `${sideEffect}import { createRouta } from "@routa-ts/core";
import { defineAppServices } from "./services.js";

export default createRouta({
\tservices: defineAppServices(() => {
\t\twriteFileSync(${JSON.stringify(sentinel)}, "factory");
\t\treturn { clock: { now: () => "" } };
\t}),
});
`,
			"src/routes/status/route.ts": statusRoute,
		});

		const generate = await run(["generate"], { cwd });

		expect(generate.stderr ?? "").toBe("");
		expect(generate.code).toBe(0);
		expect(existsSync(sentinel)).toBe(false);
	});

	it("generates the same metadata however the contract orders its services", async () => {
		const generated = [];

		for (const contract of [
			ordersContract,
			ordersContract.replace(
				"\torders: OrderStore;\n\tclock: Clock;",
				"\tclock: Clock;\n\torders: OrderStore;",
			),
		]) {
			const cwd = servicesProject({
				"src/services.ts": contract,
				"src/routa.ts": `import { createRouta } from "@routa-ts/core";
import { defineAppServices } from "./services.js";

export default createRouta({ services: defineAppServices(() => ({}) as never) });
`,
				"src/routes/orders/route.ts": ordersRoute,
			});

			expect((await run(["generate"], { cwd })).code).toBe(0);
			const first = readFileSync(join(cwd, ".routa/routes.gen.ts"), "utf8");
			expect((await run(["generate"], { cwd })).code).toBe(0);
			expect(readFileSync(join(cwd, ".routa/routes.gen.ts"), "utf8")).toBe(first);
			generated.push(first);
		}

		expect(generated[1]).toBe(generated[0]);
	});

	it("leaves OpenAPI unchanged when a project adopts application services", () => {
		const plain = servicesProject({ "src/routes/orders/route.ts": ordersRoute });
		const withServices = servicesProject({
			"src/services.ts": ordersContract,
			"src/routa.ts": `import { createRouta } from "@routa-ts/core";
import { defineAppServices } from "./services.js";

export default createRouta({ services: defineAppServices(() => ({}) as never) });
`,
			"src/routes/orders/route.ts": ordersRoute,
		});

		const document = generateOpenApi(withServices);

		expect(document).toEqual(generateOpenApi(plain));
		expect(JSON.stringify(document)).not.toMatch(/services|clock|OrderStore/);
	});
});

type Observed = { events: string[] };

/** What fixture modules record; they run in this process, so `globalThis` is shared. */
function observed(key: string): Observed {
	const store = globalThis as unknown as Record<string, Observed>;
	store[key] ??= { events: [] };
	return store[key];
}

describe("application services at startup", () => {
	afterEach(() => {
		process.exitCode = undefined;
	});

	it("refuses services that routa generate could not read", async () => {
		const cwd = servicesProject({
			"src/services.ts": clockContract,
			"src/routa.ts": `import { createRouta } from "@routa-ts/core";
import { defineAppServices } from "./services.js";

const extra = { services: defineAppServices(() => ({ clock: { now: () => "" } })) };

export default createRouta({ ...extra });
`,
			"src/routes/status/route.ts": statusRoute,
		});

		expect((await run(["generate"], { cwd })).code).toBe(0);
		await expect(createProjectApplication(cwd, cwd, "dev")).rejects.toThrow(
			"src/routa.ts configures services that routa generate could not read from source",
		);
	});

	it("refuses generated services that src/routa.ts no longer configures", async () => {
		const cwd = servicesProject({
			"src/services.ts": clockContract,
			"src/routa.ts": `import { createRouta } from "@routa-ts/core";
import { defineAppServices } from "./services.js";

export default createRouta({ services: defineAppServices(() => ({ clock: { now: () => "" } })) });
`,
			"src/routes/status/route.ts": statusRoute,
		});

		expect((await run(["generate"], { cwd })).code).toBe(0);
		writeFileSync(
			join(cwd, "src/routa.ts"),
			'import { createRouta } from "@routa-ts/core";\n\nexport default createRouta({});\n',
		);

		await expect(createProjectApplication(cwd, cwd, "dev")).rejects.toThrow(
			".routa/routes.gen.ts declares application services, but src/routa.ts configures none. Run routa generate.",
		);
	});

	it("fails startup with the factory error after releasing what it acquired", async () => {
		const key = `routa-startup-${Math.random()}`;
		const cwd = servicesProject({
			"src/services.ts": clockContract,
			"src/routa.ts": `import { createRouta } from "@routa-ts/core";
import { defineAppServices } from "./services.js";

const observed = (globalThis as any)[${JSON.stringify(key)}];

export default createRouta({
\tlogger: false,
\tservices: defineAppServices(({ onCleanup }) => {
\t\tobserved.events.push("pool acquired");
\t\tonCleanup(() => observed.events.push("pool released"));
\t\tthrow new Error("clock unavailable");
\t}),
});
`,
			"src/routes/status/route.ts": statusRoute,
		});
		const record = observed(key);

		expect((await run(["generate"], { cwd })).code).toBe(0);
		await expect(startRuntime(cwd, cwd, "dev")).rejects.toThrow("clock unavailable");
		expect(record.events).toEqual(["pool acquired", "pool released"]);
	});

	it("releases services and keeps the listener failure primary when the port is taken", async () => {
		const key = `routa-listen-${Math.random()}`;
		const blocker = createServer();
		await new Promise<void>((resolve) => blocker.listen(0, "127.0.0.1", resolve));
		const address = blocker.address();
		const port = typeof address === "object" && address ? address.port : 0;
		const cwd = servicesProject({
			"src/services.ts": clockContract,
			"src/routa.ts": `import { createLogger, createRouta } from "@routa-ts/core";
import { defineAppServices } from "./services.js";

const observed = (globalThis as any)[${JSON.stringify(key)}];

export default createRouta({
\tport: ${port},
\tlogger: createLogger({ sink: (event) => observed.events.push(event.event) }),
\tservices: defineAppServices(({ onCleanup }) => {
\t\tonCleanup(() => {
\t\t\tobserved.events.push("clock released");
\t\t\tthrow new Error("release failed");
\t\t});
\t\treturn { clock: { now: () => "" } };
\t}),
});
`,
			"src/routes/status/route.ts": statusRoute,
		});
		const record = observed(key);

		try {
			expect((await run(["generate"], { cwd })).code).toBe(0);
			await startRuntime(cwd, cwd, "start");
			await expect
				.poll(() => record.events, { timeout: 5_000 })
				.toEqual(["api.start_failed", "clock released", "services.cleanup_failed"]);
			expect(process.exitCode).toBe(1);
		} finally {
			blocker.close();
		}
	});

	it("releases services and keeps the listener failure primary when the port is invalid", async () => {
		const key = `routa-listen-invalid-${Math.random()}`;
		const cwd = servicesProject({
			"src/services.ts": clockContract,
			"src/routa.ts": `import { createLogger, createRouta } from "@routa-ts/core";
import { defineAppServices } from "./services.js";

const observed = (globalThis as any)[${JSON.stringify(key)}];

export default createRouta({
\tport: -1,
\tlogger: createLogger({ sink: (event) => observed.events.push(event.event) }),
\tservices: defineAppServices(({ onCleanup }) => {
\t\tonCleanup(() => {
\t\t\tobserved.events.push("clock released");
\t\t\tthrow new Error("release failed");
\t\t});
\t\treturn { clock: { now: () => "" } };
\t}),
});
`,
			"src/routes/status/route.ts": statusRoute,
		});
		const record = observed(key);

		expect((await run(["generate"], { cwd })).code).toBe(0);
		await expect(startRuntime(cwd, cwd, "start")).rejects.toMatchObject({
			code: "ERR_SOCKET_BAD_PORT",
		});
		expect(record.events).toEqual(["clock released", "services.cleanup_failed"]);
	});
});

const statusRoute = `import { createRoute, createRouteRoot } from "@routa-ts/core";
import { z } from "zod";

export default createRouteRoot("/status")({
\tget: createRoute({
\t\tresponses: { ok: { status: 200, schema: z.object({ ok: z.boolean() }) } },
\t\trun: () => ({ type: "ok", data: { ok: true } }),
\t}),
});
`;

const middlewareFile = (body: string) => `import { createMiddleware } from "@routa-ts/core";
import { z } from "zod";

${body}`;

describe("reserved ctx.services (routa check)", () => {
	it("reports middleware that provides services, literally or through a named binding", () => {
		for (const body of [
			"export const withDb = createMiddleware({ provides: { services: z.object({ db: z.string() }) } });\n",
			"const provides = { services: z.object({ db: z.string() }) };\n\nexport const withDb = createMiddleware({ provides });\n",
			'import { dbProvides } from "../provides.js";\n\nexport const withDb = createMiddleware({ provides: dbProvides });\n',
		]) {
			const cwd = servicesProject({
				"src/provides.ts":
					'import { z } from "zod";\n\nexport const dbProvides = { services: z.object({ db: z.string() }) };\n',
				"src/routes/middleware.ts": middlewareFile(body),
				"src/routes/status/route.ts": statusRoute,
			});
			const diagnostics = validateProject(cwd, { write: false }).diagnostics;

			expect(diagnostics).toEqual([
				{
					code: "ROUTA_CONTEXT_RESERVED",
					severity: "error",
					message:
						"Middleware withDb provides ctx.services, which Routa reserves for injected services.",
					file: "src/routes/middleware.ts",
					suggestion:
						"Rename the context key. To share an application dependency, declare it as an application service.",
				},
			]);
		}
	});

	it("reports middleware that passes services to next()", () => {
		const cwd = servicesProject({
			"src/routes/middleware.ts": middlewareFile(
				"export const withDb = createMiddleware({ run: ({ next }) => next({ services: { db: 'fake' } }) });\n",
			),
			"src/routes/status/route.ts": statusRoute,
		});

		expect(validateProject(cwd, { write: false }).diagnostics).toMatchObject([
			{
				code: "ROUTA_CONTEXT_RESERVED",
				message:
					"Middleware withDb passes ctx.services to next(), which Routa reserves for injected services.",
			},
		]);
	});

	it("reads named provides bindings into generated context", () => {
		const cwd = servicesProject({
			"src/provides.ts":
				'import { z } from "zod";\n\nexport const userProvides = { user: z.object({ id: z.string() }) };\n',
			"src/routes/middleware.ts": middlewareFile(
				'import { userProvides } from "../provides.js";\n\nexport const withUser = createMiddleware({ provides: userProvides });\n',
			),
			"src/routes/status/route.ts": statusRoute,
		});
		const inline = servicesProject({
			"src/routes/middleware.ts": middlewareFile(
				"export const withUser = createMiddleware({ provides: { user: z.object({ id: z.string() }) } });\n",
			),
			"src/routes/status/route.ts": statusRoute,
		});
		const { routes, diagnostics } = validateProject(cwd, { write: false });

		expect(diagnostics).toEqual([]);
		expect(routes[0]?.ctx).toEqual(["user"]);
		expect(routes).toEqual(validateProject(inline, { write: false }).routes);
	});

	it("reports provides declarations it cannot read instead of treating them as empty", () => {
		for (const provides of [
			"makeProvides()",
			"{ ...base, user: z.string() }",
			"{ [key]: z.string() }",
		]) {
			const cwd = servicesProject({
				"src/routes/middleware.ts": middlewareFile(
					`const key = "user";\nconst base = {};\nconst makeProvides = () => ({ user: z.string() });\n\nexport const withUser = createMiddleware({ provides: ${provides} });\n`,
				),
				"src/routes/status/route.ts": statusRoute,
			});

			expect({ provides, diagnostics: validateProject(cwd, { write: false }).diagnostics }).toEqual(
				{
					provides,
					diagnostics: [
						{
							code: "ROUTA_MIDDLEWARE_PROVIDES_UNRESOLVED",
							severity: "error",
							message: "Middleware withUser declares provides that cannot be statically read.",
							file: "src/routes/middleware.ts",
							suggestion:
								"Declare provides as an object literal, or a const object literal it names, with a plain key for each schema and no spreads.",
						},
					],
				},
			);
		}
	});
});

/** Fails with the command's own output, so a TypeScript error in a fixture is readable. */
function expectPassed(result: {
	code: number;
	stdout?: string | undefined;
	stderr?: string | undefined;
}) {
	if (result.code !== 0 || result.stderr) {
		throw new Error(`routa check failed:\n${result.stdout ?? ""}${result.stderr ?? ""}`);
	}

	expect(result.code).toBe(0);
}

/** A Routa project whose TypeScript resolves `@routa-ts/core` to this checkout's source. */
function servicesProject(files: Record<string, string>): string {
	const cwd = mkdtempSync(join(tmpdir(), "routa-services-"));
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
					zod: [join(repoRoot, "packages/core/node_modules/zod/index.d.ts")],
				},
			},
			include: ["src/**/*.ts", ".routa/**/*.ts"],
		}),
		"src/routa.ts":
			'import { createRouta } from "@routa-ts/core";\n\nexport default createRouta({});\n',
		...files,
	};

	for (const [file, content] of Object.entries(allFiles)) {
		mkdirSync(dirname(join(cwd, file)), { recursive: true });
		writeFileSync(join(cwd, file), content);
	}

	return cwd;
}
