import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { run } from "./index.js";
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
		...files,
	};

	for (const [file, content] of Object.entries(allFiles)) {
		mkdirSync(dirname(join(cwd, file)), { recursive: true });
		writeFileSync(join(cwd, file), content);
	}

	return cwd;
}
