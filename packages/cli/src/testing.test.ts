import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { run } from "./index.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

type TestApp = {
	request(input: string | URL | Request, init?: RequestInit): Promise<Response>;
	dispose(): Promise<void>;
};

type TestingModule = {
	createTestApp(options?: unknown): Promise<TestApp>;
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
