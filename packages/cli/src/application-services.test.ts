import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { run } from "./index.js";
import { validateProject } from "./project.js";
import { createProjectApplication } from "./runtime.js";

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

		expect(check.stderr ?? "", check.stdout).toBe("");
		expect(check.code).toBe(0);
		const generated = readFileSync(join(cwd, ".routa/routes.gen.ts"), "utf8");
		expect(generated).toContain('export const routaApplicationServices = [\n\t"clock"\n] as const;');
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

function diagnosticCodes(cwd: string): string[] {
	return validateProject(cwd, { write: false }).diagnostics.map((item) => item.code);
}

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
		for (const provides of ["makeProvides()", "{ ...base, user: z.string() }", "{ [key]: z.string() }"]) {
			const cwd = servicesProject({
				"src/routes/middleware.ts": middlewareFile(
					`const key = "user";\nconst base = {};\nconst makeProvides = () => ({ user: z.string() });\n\nexport const withUser = createMiddleware({ provides: ${provides} });\n`,
				),
				"src/routes/status/route.ts": statusRoute,
			});

			expect(validateProject(cwd, { write: false }).diagnostics, provides).toEqual([
				{
					code: "ROUTA_MIDDLEWARE_PROVIDES_UNRESOLVED",
					severity: "error",
					message: "Middleware withUser declares provides that cannot be statically read.",
					file: "src/routes/middleware.ts",
					suggestion:
						"Declare provides as an object literal, or a const object literal it names, with a plain key for each schema and no spreads.",
				},
			]);
		}
	});
});

/** A Routa project whose TypeScript resolves `@routa-ts/core` to this checkout's source. */
function servicesProject(files: Record<string, string>): string {
	const cwd = mkdtempSync(join(tmpdir(), "routa-services-"));
	mkdirSync(join(cwd, "node_modules/@routa-ts"), { recursive: true });
	symlinkSync(join(repoRoot, "packages/core"), join(cwd, "node_modules/@routa-ts/core"), "dir");
	symlinkSync(join(repoRoot, "packages/core/node_modules/zod"), join(cwd, "node_modules/zod"), "dir");
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
		"src/routa.ts": 'import { createRouta } from "@routa-ts/core";\n\nexport default createRouta({});\n',
		...files,
	};

	for (const [file, content] of Object.entries(allFiles)) {
		mkdirSync(dirname(join(cwd, file)), { recursive: true });
		writeFileSync(join(cwd, file), content);
	}

	return cwd;
}
