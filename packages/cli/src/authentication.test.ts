import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { run } from "./index.js";
import { createProjectApplication } from "./runtime.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const routaConfig = `import { bearer, createRouta } from "@routa-ts/core";
import { z } from "zod";

const Principal = z.discriminatedUnion("type", [
\tz.object({ type: z.literal("user"), id: z.string(), email: z.string() }),
\tz.object({ type: z.literal("service"), id: z.string() }),
]);

export default createRouta({
\tauthentication: {
\t\tprincipal: Principal,
\t\tschemes: {
\t\t\tuserToken: bearer({
\t\t\t\tchallenge: { realm: "api" },
\t\t\t\tauthenticate: (token) =>
\t\t\t\t\ttoken === "user-token"
\t\t\t\t\t\t? { type: "authenticated", principal: { type: "user", id: "user_1", email: "a@example.com" } }
\t\t\t\t\t\t: { type: "rejected" },
\t\t\t}),
\t\t},
\t},
});
`;

const meRoute = `import { createRoute, createRouteRoot } from "@routa-ts/core";
import { z } from "zod";

export default createRouteRoot("/me")({
\tget: createRoute({
\t\tresponses: { ok: { status: 200, schema: z.object({ who: z.string() }) } },
\t\trun: ({ ctx }) => {
\t\t\t// Type assertions only; never called.
\t\t\tconst typeChecks = () => {
\t\t\t\t// @ts-expect-error A public route may be anonymous, so narrow before reading the principal.
\t\t\t\tvoid ctx.auth.principal;
\t\t\t\t// @ts-expect-error ctx.auth is readonly.
\t\t\t\tctx.auth = { status: "anonymous" };
\t\t\t};
\t\t\tvoid typeChecks;

\t\t\tif (ctx.auth.status === "anonymous") {
\t\t\t\treturn { type: "ok", data: { who: "anonymous" } };
\t\t\t}

\t\t\tconst scheme: "userToken" = ctx.auth.scheme;
\t\t\tconst principal = ctx.auth.principal;
\t\t\treturn {
\t\t\t\ttype: "ok",
\t\t\t\tdata: { who: \`\${scheme}:\${principal.type === "user" ? principal.email : principal.id}\` },
\t\t\t};
\t\t},
\t}),
});
`;

const projectsRoute = `import { createRoute, createRouteRoot, requireAuth } from "@routa-ts/core";
import { z } from "zod";

export default createRouteRoot("/projects")({
\tget: createRoute({
\t\tresponses: { ok: { status: 200, schema: z.object({ visibility: z.string() }) } },
\t\trun: ({ ctx }) => ({ type: "ok", data: { visibility: ctx.auth.status } }),
\t}),
\tpost: createRoute({
\t\tmiddleware: [requireAuth()],
\t\tinput: { body: z.object({ name: z.string() }) },
\t\tresponses: { created: { status: 201, schema: z.object({ owner: z.string(), name: z.string() }) } },
\t\trun: ({ ctx, input }) => {
\t\t\tconst status: "authenticated" = ctx.auth.status;
\t\t\tvoid status;
\t\t\treturn { type: "created", data: { owner: ctx.auth.principal.id, name: input.body.name } };
\t\t},
\t}),
});
`;

describe("Bearer authentication in a project", () => {
	it("types ctx.auth, narrows it after requireAuth, and serves the same contract", async () => {
		const cwd = project({
			"src/routa.ts": routaConfig,
			"src/routes/me/route.ts": meRoute,
			"src/routes/projects/route.ts": projectsRoute,
		});

		expectPassed(await run(["check"], { cwd }));

		const generated = readFileSync(join(cwd, ".routa/routes.gen.ts"), "utf8");
		expect(generated).toContain(
			'export const routaAuthenticationSchemes = [\n\t"userToken"\n] as const;',
		);

		const { application } = await createProjectApplication(cwd, cwd, "dev");
		const request = (path: string, init: RequestInit = {}) =>
			application.fetch(new Request(`http://localhost${path}`, init));
		const create = (headers: Record<string, string>) =>
			request("/projects", {
				method: "POST",
				headers: { "content-type": "application/json", ...headers },
				body: JSON.stringify({ name: "Atlas" }),
			});

		expect(await (await request("/me")).json()).toEqual({ who: "anonymous" });
		expect(
			await (await request("/me", { headers: { authorization: "Bearer user-token" } })).json(),
		).toEqual({ who: "userToken:a@example.com" });

		const required = await create({});
		expect(required.status).toBe(401);
		expect(required.headers.get("www-authenticate")).toBe('Bearer realm="api"');

		const failed = await create({ authorization: "Bearer expired" });
		expect(failed.status).toBe(401);
		expect(failed.headers.get("www-authenticate")).toBe(
			'Bearer realm="api", error="invalid_token"',
		);

		expect(await (await create({ authorization: "Bearer user-token" })).json()).toEqual({
			owner: "user_1",
			name: "Atlas",
		});
		await application.dispose();
	}, 30_000);
});

function expectPassed(result: {
	code: number;
	stdout?: string | undefined;
	stderr?: string | undefined;
}) {
	if (result.code !== 0 || result.stderr) {
		throw new Error(`routa check failed:\n${result.stdout ?? ""}${result.stderr ?? ""}`);
	}
}

/** A Routa project whose TypeScript resolves `@routa-ts/core` to this checkout's source. */
function project(files: Record<string, string>): string {
	const cwd = mkdtempSync(join(tmpdir(), "routa-authentication-"));
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
