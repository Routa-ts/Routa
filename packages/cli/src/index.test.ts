import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { run } from "./index.js";
import { generateOpenApi } from "./openapi.js";
import {
	sourceSnapshot,
	sourceSnapshotChanged,
	stubEmptyRouteFiles,
	validateProject,
} from "./project.js";
import { loadRoutes } from "./runtime.js";
import { shouldUseColor } from "./ui.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("routa cli", () => {
	it("prints help by default", () => {
		const result = run([]);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("routa create [dir]");
	});

	it("prints colored help only when color is enabled", () => {
		expect(run([]).stdout).not.toContain("\u001b[");
		expect(run([], { color: true }).stdout).toContain("\u001b[");
	});

	it("honors explicit color environment overrides", () => {
		const originalEnv = { ...process.env };
		const stdoutIsTTY = process.stdout.isTTY;

		try {
			Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
			process.env.CI = "true";
			process.env.FORCE_COLOR = "1";
			delete process.env.NO_COLOR;

			expect(shouldUseColor()).toBe(true);

			Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
			process.env.FORCE_COLOR = "0";

			expect(shouldUseColor()).toBe(false);

			delete process.env.FORCE_COLOR;
			process.env.NO_COLOR = "";

			expect(shouldUseColor()).toBe(false);
		} finally {
			process.env = originalEnv;
			Object.defineProperty(process.stdout, "isTTY", {
				value: stdoutIsTTY,
				configurable: true,
			});
		}
	});

	it("requires an OpenAPI file for scaffold", () => {
		const result = run(["scaffold"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("Missing OpenAPI input file");
	});

	it("creates a starter project from the advertised CLI command", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-cli-create-"));

		const result = await run(["create", "my-api", "--no-openapi", "--no-git", "--no-install"], {
			cwd,
		});

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("Your Routa app is ready");
		expect(result.stdout).toContain("pnpm dev");
		expect(result.stdout).toContain("Let's configure your Routa API");
		expect(existsSync(join(cwd, "my-api/package.json"))).toBe(true);
		expect(existsSync(join(cwd, "my-api/src/routes/status/route.ts"))).toBe(true);
		expect(existsSync(join(cwd, "my-api/openapi.yaml"))).toBe(false);
	});

	it("accepts scaffold flags before the OpenAPI input file", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-scaffold-flags-before-"));
		createTypeScriptProject(cwd);
		writeSimpleUsersOpenApi(cwd);

		const result = run(["scaffold", "--preview", "openapi.yaml"], { cwd });

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("Previewed");
		expect(existsSync(join(cwd, "src/routes/users/route.ts"))).toBe(false);
	});

	it("generates route metadata after validating a route graph", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-check-"));
		createTypeScriptProject(cwd);
		mkdirSync(join(cwd, "src/routes/(private)/users"), { recursive: true });
		writeFileSync(
			join(cwd, "src/routes/middleware.ts"),
			`import { createMiddleware } from "@routa-ts/core";
import { z } from "zod";

export const withDb = createMiddleware({
\tprovides: {
\t\tdb: z.object({
\t\t\tquery: z.string(),
\t\t}),
\t},
\trun: async ({ next }) => {
\t\treturn next({
\t\t\tdb: {
\t\t\t\tquery: "select 1",
\t\t\t},
\t\t});
\t},
});
`,
		);
		writeFileSync(
			join(cwd, "src/routes/(private)/middleware.ts"),
			`import { createMiddleware } from "@routa-ts/core";
import { z } from "zod";

export const requireAuth = createMiddleware({
\trequires: ["db"],
\tprovides: {
\t\tuser: z.unknown(),
\t},
});
`,
		);
		writeFileSync(
			join(cwd, "src/routes/(private)/users/route.ts"),
			`import { createRouteRoot } from "@routa-ts/core";

export default createRouteRoot("/users")({});
`,
		);

		const result = run(["generate"], { cwd });

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("Generated .routa/routes.gen.ts for 1 route file(s).");
		expect(readFileSync(join(cwd, ".routa/routes.gen.ts"), "utf8")).toContain('"/users"');
		expect(readFileSync(join(cwd, ".routa/routes.gen.ts"), "utf8")).toContain(
			"src/routes/(private)/middleware.ts",
		);
		expect(readFileSync(join(cwd, ".routa/routes.gen.ts"), "utf8")).toContain('"provides"');
		expect(readFileSync(join(cwd, ".routa/routes.gen.ts"), "utf8")).toContain('"ctx"');
		expect(readFileSync(join(cwd, ".routa/routes.gen.ts"), "utf8")).toContain('"db"');
		expect(readFileSync(join(cwd, ".routa/routes.gen.ts"), "utf8")).toContain('"user"');
		expect(readFileSync(join(cwd, ".routa/routes.gen.ts"), "utf8")).toContain(
			"export type UsersCtx",
		);
	}, 15_000);

	it("reports when check runs TypeScript no-emit", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-check-type-error-"));
		createTypeScriptProject(cwd);
		mkdirSync(join(cwd, "src/routes/users"), { recursive: true });
		writeFileSync(
			join(cwd, "src/routes/users/route.ts"),
			`import { createRouteRoot } from "@routa-ts/core";

const userId: string = 1;

export default createRouteRoot("/users")({});
`,
		);

		const result = run(["check"], { cwd });

		expect(result.code).toBe(1);
		expect(result.stdout).toContain("Routa validation passed for 1 route file(s).");
		expect(result.stdout).toContain("Running TypeScript check: tsc -p tsconfig.json --noEmit");
		expect(result.stderr).toContain("TypeScript check failed.");
	});

	it("typechecks middleware requires against provided ctx keys", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-middleware-requires-typecheck-"));
		createTypeScriptProject(cwd);
		mkdirSync(join(cwd, "src/middleware"), { recursive: true });
		mkdirSync(join(cwd, "src/routes/status"), { recursive: true });
		writeFileSync(
			join(cwd, "src/middleware/permissions.ts"),
			`import { createMiddleware } from "@routa-ts/core";
import { z } from "zod";

export const withProjectPermissions = createMiddleware({
\trequires: ["requiredUser"],
\tprovides: {
\t\tprojectPermissions: z.object({
\t\t\tcanRead: z.boolean(),
\t\t}),
\t},
});
`,
		);
		writeFileSync(
			join(cwd, "src/routes/status/route.ts"),
			`import { createRoute, createRouteRoot } from "@routa-ts/core";
import { z } from "zod";

export default createRouteRoot("/status")({
\tget: createRoute({
\t\tresponses: {
\t\t\tsuccess: {
\t\t\t\tstatus: 200,
\t\t\t\tschema: z.object({ ok: z.boolean() }),
\t\t\t},
\t\t},
\t\trun: () => ({ type: "success", data: { ok: true } }),
\t}),
});
`,
		);

		const result = run(["check"], { cwd });

		expect(result.code).toBe(1);
		expect(result.stdout).toContain("Running TypeScript check: tsc -p tsconfig.json --noEmit");
		expect(result.stderr).toContain("TypeScript check failed.");
		expect(result.stdout).toContain("requiredUser");
	});

	it("reports middleware order diagnostics when requirements are missing", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-middleware-order-"));
		createTypeScriptProject(cwd);
		mkdirSync(join(cwd, "src/routes/(private)/users"), { recursive: true });
		writeFileSync(
			join(cwd, "src/routes/(private)/middleware.ts"),
			`import { createMiddleware } from "@routa-ts/core";
import { z } from "zod";

export const requireAuth = createMiddleware({
\trequires: ["db"],
\tprovides: {
\t\tuser: z.unknown(),
\t},
});
`,
		);
		writeFileSync(
			join(cwd, "src/routes/(private)/users/route.ts"),
			`import { createRoute, createRouteRoot } from "@routa-ts/core";

const requirePermission = createMiddleware({
\trequires: ["user"],
});

export default createRouteRoot("/users")({
\tmiddleware: [requirePermission],
});
`,
		);

		const result = run(["check"], { cwd });

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("ROUTA_MIDDLEWARE_ORDER");
		expect(result.stderr).toContain("requires ctx.db");
	});

	it("reports middleware that cannot be statically resolved", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-middleware-unresolved-"));
		createTypeScriptProject(cwd);
		mkdirSync(join(cwd, "src/routes/users"), { recursive: true });
		writeFileSync(
			join(cwd, "src/routes/users/route.ts"),
			`import { createMiddleware, createRoute, createRouteRoot } from "@routa-ts/core";
import { z } from "zod";

const loadUserResource = createMiddleware({
\tprovides: {
\t\tuserResource: z.unknown(),
\t},
});

const commonMiddleware = [loadUserResource];

export default createRouteRoot("/users")({
\tmiddleware: [...commonMiddleware],
\tget: createRoute({
\t\tresponses: {
\t\t\tsuccess: {
\t\t\t\tstatus: 200,
\t\t\t\tschema: z.unknown(),
\t\t\t},
\t\t},
\t\trun: () => ({ type: "success", data: null }),
\t}),
});
`,
		);

		const result = run(["check"], { cwd });

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("ROUTA_MIDDLEWARE_UNRESOLVED");
		expect(result.stderr).toContain("...commonMiddleware");
	});

	it("injects middleware rejection responses into route metadata", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-middleware-rejects-"));
		createTypeScriptProject(cwd);
		mkdirSync(join(cwd, "src/routes/users"), { recursive: true });
		writeFileSync(
			join(cwd, "src/routes/users/route.ts"),
			`import { createMiddleware, createRoute, createRouteRoot } from "@routa-ts/core";
import { z } from "zod";

const requireAuth = createMiddleware({
\tprovides: {
\t\tuser: z.unknown(),
\t},
\trejects: {
\t\tunauthorized: {
\t\t\tstatus: 401,
\t\t\tschema: z.object({ message: z.string() }),
\t\t},
\t},
});

export default createRouteRoot("/users")({
\tmiddleware: [requireAuth],
\tget: createRoute({
\t\tresponses: {
\t\t\tsuccess: {
\t\t\t\tstatus: 200,
\t\t\t\tschema: z.unknown(),
\t\t\t},
\t\t},
\t\trun: () => ({ type: "success", data: null }),
\t}),
});
`,
		);

		const declared = run(["check"], { cwd });

		expect(declared.code).toBe(0);
		const metadata = JSON.parse(
			readFileSync(join(cwd, ".routa/routes.gen.ts"), "utf8").match(
				/export const routaRoutes = ([\s\S]*?) as const;/,
			)?.[1] ?? "[]",
		);
		expect(metadata[0].responses.get).toEqual([200, 401]);
		expect(metadata[0].middleware[0].rejects).toEqual([
			{
				type: "unauthorized",
				status: 401,
				schema: "z.object({ message: z.string() })",
			},
		]);
	});

	it("applies route-file middleware before method middleware", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-route-method-middleware-"));
		createTypeScriptProject(cwd);
		mkdirSync(join(cwd, "src/routes/users/$id"), { recursive: true });
		writeFileSync(
			join(cwd, "src/routes/users/$id/route.ts"),
			`import { createMiddleware, createRoute, createRouteRoot } from "@routa-ts/core";
import { z } from "zod";

const loadUserResource = createMiddleware({
\tprovides: {
\t\tuserResource: z.unknown(),
\t},
});

const requirePermission = createMiddleware({
\trequires: ["userResource"],
\tprovides: {
\t\tpermission: z.unknown(),
\t},
});

export default createRouteRoot("/users/:id")({
\tmiddleware: [loadUserResource],
\tpatch: createRoute({
\t\tmiddleware: [requirePermission],
\t\tresponses: {
\t\t\tsuccess: {
\t\t\t\tstatus: 200,
\t\t\t\tschema: z.unknown(),
\t\t\t},
\t\t},
\t\trun: () => ({ type: "success", data: null }),
\t}),
});
`,
		);

		const result = run(["check"], { cwd });

		expect(result.code).toBe(0);
		const metadata = readFileSync(join(cwd, ".routa/routes.gen.ts"), "utf8");
		expect(metadata.indexOf("loadUserResource")).toBeLessThan(
			metadata.indexOf("requirePermission"),
		);
		expect(metadata).toContain('"userResource"');
		expect(metadata).toContain('"permission"');
	});

	it("keeps route middleware before method middleware regardless of property order", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-route-method-middleware-order-"));
		createTypeScriptProject(cwd);
		mkdirSync(join(cwd, "src/routes/users/$id"), { recursive: true });
		writeFileSync(
			join(cwd, "src/routes/users/$id/route.ts"),
			`import { createMiddleware, createRoute, createRouteRoot } from "@routa-ts/core";
import { z } from "zod";

const loadUserResource = createMiddleware({
\tprovides: {
\t\tuserResource: z.unknown(),
\t},
});

const requirePermission = createMiddleware({
\trequires: ["userResource"],
\tprovides: {
\t\tpermission: z.unknown(),
\t},
});

export default createRouteRoot("/users/:id")({
\tpatch: createRoute({
\t\tmiddleware: [requirePermission],
\t\tresponses: {
\t\t\tsuccess: {
\t\t\t\tstatus: 200,
\t\t\t\tschema: z.unknown(),
\t\t\t},
\t\t},
\t\trun: () => ({ type: "success", data: null }),
\t}),
\tmiddleware: [loadUserResource],
});
`,
		);

		const result = run(["check"], { cwd });

		expect(result.code).toBe(0);
		const metadata = readFileSync(join(cwd, ".routa/routes.gen.ts"), "utf8");
		expect(metadata.indexOf("loadUserResource")).toBeLessThan(
			metadata.indexOf("requirePermission"),
		);
	});

	it("keeps per-method middleware out of other method chains", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-method-specific-middleware-"));
		createTypeScriptProject(cwd);
		mkdirSync(join(cwd, "src/routes/users"), { recursive: true });
		writeFileSync(
			join(cwd, "src/routes/users/route.ts"),
			`import { createMiddleware, createRoute, createRouteRoot } from "@routa-ts/core";
import { z } from "zod";

const loadUserResource = createMiddleware({
\tprovides: {
\t\tuserResource: z.unknown(),
\t},
});

const requirePermission = createMiddleware({
\trequires: ["userResource"],
\tprovides: {
\t\tpermission: z.unknown(),
\t},
});

export default createRouteRoot("/users")({
\tget: createRoute({
\t\tresponses: {
\t\t\tsuccess: {
\t\t\t\tstatus: 200,
\t\t\t\tschema: z.unknown(),
\t\t\t},
\t\t},
\t\trun: () => ({ type: "success", data: null }),
\t}),
\tpatch: createRoute({
\t\tmiddleware: [loadUserResource, requirePermission],
\t\tresponses: {
\t\t\tsuccess: {
\t\t\t\tstatus: 200,
\t\t\t\tschema: z.unknown(),
\t\t\t},
\t\t},
\t\trun: () => ({ type: "success", data: null }),
\t}),
});
`,
		);

		const result = run(["check"], { cwd });

		expect(result.code).toBe(0);
		const metadata = JSON.parse(
			readFileSync(join(cwd, ".routa/routes.gen.ts"), "utf8").match(
				/export const routaRoutes = ([\s\S]*?) as const;/,
			)?.[1] ?? "[]",
		);
		expect(metadata[0].middleware).toEqual([]);
		expect(metadata[0].methodMiddleware.get).toEqual([]);
		expect(metadata[0].methodMiddleware.patch.map((item: { name: string }) => item.name)).toEqual([
			"loadUserResource",
			"requirePermission",
		]);
	});

	it("applies route-local middleware to all methods and method middleware only to that method", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-route-local-middleware-"));
		createTypeScriptProject(cwd);
		mkdirSync(join(cwd, "src/middleware"), { recursive: true });
		mkdirSync(join(cwd, "src/routes/users"), { recursive: true });
		writeFileSync(
			join(cwd, "src/middleware/context.ts"),
			`import { createMiddleware } from "@routa-ts/core";

export const withRouteCtx = createMiddleware({
\tprovides: {
\t\trouteCtx: {} as any,
\t},
\trun: async ({ next }) => next({ routeCtx: { label: "all" } }),
});

export const withGetCtx = createMiddleware({
\trequires: ["routeCtx"],
\tprovides: {
\t\tgetCtx: {} as any,
\t},
\trun: async ({ next }) => next({ getCtx: { label: "get" } }),
});
`,
		);
		writeFileSync(
			join(cwd, "src/routes/users/route.ts"),
			`import { createRoute, createRouteRoot } from "@routa-ts/core";
import { withGetCtx, withRouteCtx } from "../../middleware/context.js";

const route = createRouteRoot("/users");

export default route({
\tmiddleware: [withRouteCtx],
\tget: createRoute({
\t\tmiddleware: [withGetCtx],
\t\tresponses: {
\t\t\tsuccess: {
\t\t\t\tstatus: 200,
\t\t\t\tschema: {} as any,
\t\t\t},
\t\t},
\t\trun: () => ({ type: "success", data: { label: "get" } }),
\t}),
\tpost: createRoute({
\t\tresponses: {
\t\t\tsuccess: {
\t\t\t\tstatus: 201,
\t\t\t\tschema: {} as any,
\t\t\t},
\t\t},
\t\trun: () => ({ type: "success", data: { label: "post" } }),
\t}),
});
`,
		);

		const result = run(["check"], { cwd });

		expect(result.code).toBe(0);
		const metadata = JSON.parse(
			readFileSync(join(cwd, ".routa/routes.gen.ts"), "utf8").match(
				/export const routaRoutes = ([\s\S]*?) as const;/,
			)?.[1] ?? "[]",
		);
		expect(metadata[0].middleware.map((item: { name: string }) => item.name)).toEqual([
			"withRouteCtx",
		]);
		expect(metadata[0].methodMiddleware.get.map((item: { name: string }) => item.name)).toEqual([
			"withRouteCtx",
			"withGetCtx",
		]);
		expect(metadata[0].methodMiddleware.post.map((item: { name: string }) => item.name)).toEqual([
			"withRouteCtx",
		]);

		const routes = await loadRoutes(cwd);
		const getRoute = routes.find((route) => route.method === "get");
		const postRoute = routes.find((route) => route.method === "post");

		expect(getRoute?.contract.middleware).toHaveLength(2);
		expect(postRoute?.contract.middleware).toHaveLength(1);
	});

	it("prints a JSON route reference from resolved route metadata", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-routes-json-"));
		createTypeScriptProject(cwd);
		mkdirSync(join(cwd, "src/routes/(private)/users"), { recursive: true });
		writeFileSync(
			join(cwd, "src/routes/(private)/middleware.ts"),
			`import { createMiddleware } from "@routa-ts/core";
import { z } from "zod";

export const withSession = createMiddleware({
\tprovides: {
\t\tsession: z.object({ authenticated: z.boolean() }),
\t},
});
`,
		);
		writeFileSync(
			join(cwd, "src/routes/(private)/users/route.ts"),
			`import { createMiddleware, createRoute, createRouteRoot } from "@routa-ts/core";
import { z } from "zod";

const requireAuth = createMiddleware({
\trequires: ["session"],
\tprovides: {
\t\tauth: z.object({ userId: z.string() }),
\t},
\trejects: {
\t\tunauthorized: {
\t\t\tstatus: 401,
\t\t\tschema: z.object({ message: z.string() }),
\t\t},
\t},
});

export default createRouteRoot("/users")({
\tget: createRoute({
\t\tmiddleware: [requireAuth],
\t\tinput: {
\t\t\tquery: z.object({ limit: z.coerce.number().optional() }),
\t\t},
\t\tresponses: {
\t\t\tsuccess: {
\t\t\t\tstatus: 200,
\t\t\t\tschema: z.unknown(),
\t\t\t},
\t\t},
\t\trun: () => ({ type: "success", data: null }),
\t}),
});
`,
		);

		const result = run(["routes", "--format", "json"], { cwd });

		expect(result.code).toBe(0);
		const reference = JSON.parse(result.stdout ?? "{}");
		expect(reference.routes).toHaveLength(1);
		expect(reference.routes[0].path).toBe("/users");
		expect(reference.routes[0].groups).toEqual(["(private)"]);
		expect(reference.routes[0].methods[0]).toMatchObject({
			method: "GET",
			inputs: { query: true },
			responses: [200, 401],
			ctx: ["auth", "session"],
			rejects: [
				{
					type: "unauthorized",
					status: 401,
					schema: "z.object({ message: z.string() })",
				},
			],
		});
		expect(
			reference.routes[0].methods[0].middleware.map((item: { name: string }) => item.name),
		).toEqual(["withSession", "requireAuth"]);
	});

	it("prints a Markdown route reference by default", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-routes-markdown-"));
		createTypeScriptProject(cwd);
		mkdirSync(join(cwd, "src/routes/status"), { recursive: true });
		writeFileSync(
			join(cwd, "src/routes/status/route.ts"),
			`import { createRoute, createRouteRoot } from "@routa-ts/core";
import { z } from "zod";

export default createRouteRoot("/status")({
\tget: createRoute({
\t\tresponses: {
\t\t\tsuccess: {
\t\t\t\tstatus: 200,
\t\t\t\tschema: z.unknown(),
\t\t\t},
\t\t},
\t\trun: () => ({ type: "success", data: null }),
\t}),
});
`,
		);

		const result = run(["routes"], { cwd });

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("# Routa Route Reference");
		expect(result.stdout).toContain("## /status");
		expect(result.stdout).toContain("### GET");
		expect(result.stdout).toContain("Middleware:");
	});

	it("rejects invalid route reference formats", () => {
		const result = run(["routes", "--format", "yaml"], { cwd: repoRoot });

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("Invalid routes format");
	});

	it("rejects malformed generated middleware exports at runtime", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-malformed-middleware-"));
		createTypeScriptProject(cwd);
		mkdirSync(join(cwd, ".routa"), { recursive: true });
		mkdirSync(join(cwd, "src/routes/users"), { recursive: true });
		writeFileSync(
			join(cwd, "src/routes/middleware.ts"),
			`export const withTenant = {};
`,
		);
		writeFileSync(
			join(cwd, "src/routes/users/route.ts"),
			`import { createRoute, createRouteRoot } from "@routa-ts/core";

export default createRouteRoot("/users")({
\tget: createRoute({
\t\tresponses: {
\t\t\tsuccess: {
\t\t\t\tstatus: 200,
\t\t\t\tschema: {} as any,
\t\t\t},
\t\t},
\t\trun: () => ({ type: "success", data: { ok: true } }),
\t}),
});
`,
		);
		writeFileSync(
			join(cwd, ".routa/routes.gen.ts"),
			`export const routaRoutes = [
\t{
\t\tfile: "src/routes/users/route.ts",
\t\tpath: "/users",
\t\tmethods: ["GET"],
\t\tresponses: { get: [200] },
\t\tinputs: { get: { params: false, query: false, headers: false, cookies: false, body: false } },
\t\tmiddleware: [],
\t\tmethodMiddleware: {
\t\t\tget: [
\t\t\t{
\t\t\t\tfile: "src/routes/middleware.ts",
\t\t\t\tname: "withTenant",
\t\t\t\trequires: [],
\t\t\t\tprovides: [],
\t\t\t\tprovidesTypes: {},
\t\t\t\trejects: [],
\t\t\t},
\t\t\t],
\t\t},
\t\tctx: [],
\t\tgroups: [],
\t\tsegments: ["users"],
\t},
] as const;
`,
		);

		await expect(loadRoutes(cwd)).rejects.toThrow(
			"Middleware withTenant was not exported by src/routes/middleware.ts.",
		);
	});

	it("parses middleware contracts with nested input schemas", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-middleware-input-"));
		createTypeScriptProject(cwd);
		mkdirSync(join(cwd, "src/routes/users"), { recursive: true });
		writeFileSync(
			join(cwd, "src/routes/middleware.ts"),
			`import { createMiddleware } from "@routa-ts/core";
import { z } from "zod";

export const withTenant = createMiddleware({
\tinput: {
\t\theaders: z.object({
\t\t\t"x-tenant-id": z.string(),
\t\t}),
\t},
\tprovides: {
\t\ttenant: z.string(),
\t},
});
`,
		);
		writeFileSync(
			join(cwd, "src/routes/users/route.ts"),
			`import { createMiddleware, createRouteRoot } from "@routa-ts/core";

const requireTenant = createMiddleware({
\trequires: ["tenant"],
});

export default createRouteRoot("/users")({
\tmiddleware: [requireTenant],
});
`,
		);

		const result = run(["check"], { cwd });

		expect(result.code).toBe(0);
		expect(readFileSync(join(cwd, ".routa/routes.gen.ts"), "utf8")).toContain('"tenant"');
	});

	it("types handler ctx through createRouteRoot path lookup", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-route-root-ctx-"));
		createTypeScriptProject(cwd);
		mkdirSync(join(cwd, "src/routes/users"), { recursive: true });
		writeFileSync(
			join(cwd, "src/routes/middleware.ts"),
			`import { createMiddleware } from "@routa-ts/core";
import { z } from "zod";

export const withDb = createMiddleware({
\tprovides: {
\t\tdb: z.object({
\t\t\tquery: z.string(),
\t\t}),
\t},
\trun: async ({ next }) => {
\t\treturn next({
\t\t\tdb: {
\t\t\t\tquery: "select 1",
\t\t\t},
\t\t});
\t},
});
`,
		);
		writeFileSync(
			join(cwd, "src/routes/users/route.ts"),
			`import { createRoute, createRouteRoot } from "@routa-ts/core";
import { z } from "zod";

const route = createRouteRoot("/users");

export default route({
\tget: createRoute({
\t\tresponses: {
\t\t\tsuccess: {
\t\t\t\tstatus: 200,
\t\t\t\tschema: z.object({ ok: z.boolean() }),
\t\t\t},
\t\t},
\t\trun: ({ ctx }) => {
\t\t\treturn { type: "success", data: { ok: ctx.db.query.length > 0 } };
\t\t},
\t}),
});
`,
		);

		const result = run(["check"], { cwd });

		expect(result.code).toBe(0);
		expect(readFileSync(join(cwd, ".routa/routes.gen.ts"), "utf8")).toContain(
			'declare module "@routa-ts/core"',
		);
	});

	it("types imported middleware required ctx from generated ctx keys", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-imported-middleware-ctx-"));
		createTypeScriptProject(cwd);
		mkdirSync(join(cwd, "src/middleware"), { recursive: true });
		mkdirSync(join(cwd, "src/routes/users"), { recursive: true });
		writeFileSync(
			join(cwd, "src/middleware/context.ts"),
			`import { createMiddleware } from "@routa-ts/core";
import { z } from "zod";

export const withDb = createMiddleware({
\tprovides: {
\t\tdb: z.object({
\t\t\tquery: z.string(),
\t\t}),
\t},
});

export const withUser = createMiddleware({
\trequires: ["db"],
\tprovides: {
\t\tuser: z.object({
\t\t\tloaded: z.boolean(),
\t\t}),
\t},
\trun: async ({ ctx, next }) => {
\t\treturn next({
\t\t\tuser: {
\t\t\t\tloaded: ctx.db.query.length > 0,
\t\t\t},
\t\t});
\t},
});
`,
		);
		writeFileSync(
			join(cwd, "src/routes/middleware.ts"),
			`export { withDb, withUser } from "../middleware/context.js";
`,
		);
		writeFileSync(
			join(cwd, "src/routes/users/route.ts"),
			`import { createRoute, createRouteRoot } from "@routa-ts/core";
import { z } from "zod";

const route = createRouteRoot("/users");

export default route({
\tget: createRoute({
\t\tresponses: {
\t\t\tsuccess: {
\t\t\t\tstatus: 200,
\t\t\t\tschema: z.object({ ok: z.boolean() }),
\t\t\t},
\t\t},
\t\trun: ({ ctx }) => ({ type: "success", data: { ok: ctx.user.loaded } }),
\t}),
});
`,
		);

		const result = run(["check"], { cwd });

		expect(result.code).toBe(0);
		const metadata = readFileSync(join(cwd, ".routa/routes.gen.ts"), "utf8");
		expect(metadata).toContain("src/middleware/context.ts");
		expect(metadata).toContain('"db"');
		expect(metadata).toContain('"user"');
		expect(metadata).toContain("export type RoutaCtxByKey");
	});

	it("parses direct route contracts with nested input schemas through TypeScript AST", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-route-ast-input-"));
		createTypeScriptProject(cwd);
		mkdirSync(join(cwd, "src/routes/search"), { recursive: true });
		writeFileSync(
			join(cwd, "src/routes/search/route.ts"),
			`import { createRoute, createRouteRoot } from "@routa-ts/core";
import { z } from "zod";

export default createRouteRoot("/search")({
\tget: createRoute({
\t\tinput: {
\t\t\tquery: z.object({
\t\t\t\tfilters: z.object({
\t\t\t\t\tstatus: z.string(),
\t\t\t\t}),
\t\t\t}),
\t\t},
\t\tresponses: {
\t\t\tsuccess: {
\t\t\t\tstatus: 200,
\t\t\t\tschema: z.object({
\t\t\t\t\tbody: z.string(),
\t\t\t\t}),
\t\t\t},
\t\t},
\t\trun: () => ({ type: "success", data: { body: "" } }),
\t}),
});
`,
		);

		const result = run(["check"], { cwd });

		expect(result.code).toBe(0);
		const metadata = readFileSync(join(cwd, ".routa/routes.gen.ts"), "utf8");
		expect(metadata).toContain('"query": true');
		expect(metadata).toContain('"body": false');
		expect(metadata).toContain('"responses": {');
		expect(metadata).toContain('"get": [');
		expect(metadata).toContain("200");
	});

	it("reports duplicate route paths before typechecking", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-duplicate-routes-"));
		createTypeScriptProject(cwd);
		mkdirSync(join(cwd, "src/routes/users"), { recursive: true });
		mkdirSync(join(cwd, "src/routes/(admin)/users"), { recursive: true });
		const routeSource = `import { createRouteRoot } from "@routa-ts/core";

export default createRouteRoot("/users")({});
`;
		writeFileSync(join(cwd, "src/routes/users/route.ts"), routeSource);
		writeFileSync(join(cwd, "src/routes/(admin)/users/route.ts"), routeSource);

		const result = run(["build"], { cwd });

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("ROUTA_DUPLICATE_ROUTE");
		expect(result.stderr).toContain("/users");
	});

	it("uses the internal package runtime for dev and start", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-server-entry-"));
		createTypeScriptProject(cwd);
		mkdirSync(join(cwd, "src/routes/status"), { recursive: true });
		writeFileSync(
			join(cwd, "src/routes/status/route.ts"),
			`import { createRoute, createRouteRoot } from "@routa-ts/core";
import { z } from "zod";

export default createRouteRoot("/status")({
\tget: createRoute({
\t\tresponses: {
\t\t\tsuccess: {
\t\t\t\tstatus: 200,
\t\t\t\tschema: z.object({ ok: z.boolean() }),
\t\t\t},
\t\t},
\t\trun: () => ({ type: "success", data: { ok: true } }),
\t}),
});
`,
		);

		const dev = run(["dev", "--print"], { cwd });
		writeCompiledRuntimeFiles(cwd, [
			"src/routa.ts",
			".routa/routes.gen.ts",
			"src/routes/status/route.ts",
		]);
		const start = run(["start", "--print"], { cwd });

		expect(dev.code).toBe(0);
		expect(start.code).toBe(0);
		expect(dev.stdout).toContain("runtime.js");
		expect(start.stdout).toContain("runtime.js");
		expect(existsSync(join(cwd, ".routa/server.ts"))).toBe(false);
		expect(readFileSync(join(cwd, ".routa/routes.gen.ts"), "utf8")).toContain('"/status"');
	});

	it("fails production start preparation when dist output is missing", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-start-missing-dist-"));
		createTypeScriptProject(cwd);
		mkdirSync(join(cwd, "src/routes/status"), { recursive: true });
		writeFileSync(
			join(cwd, "src/routes/status/route.ts"),
			`import { createRoute, createRouteRoot } from "@routa-ts/core";
import { z } from "zod";

export default createRouteRoot("/status")({
\tget: createRoute({
\t\tresponses: {
\t\t\tsuccess: {
\t\t\t\tstatus: 200,
\t\t\t\tschema: z.object({ ok: z.boolean() }),
\t\t\t},
\t\t},
\t\trun: () => ({ type: "success", data: { ok: true } }),
\t}),
});
`,
		);

		const start = run(["start", "--print"], { cwd });

		expect(start.code).toBe(1);
		expect(start.stderr).toContain("Run routa build first.");
	});

	it("fails production start preparation when generated schema output is missing", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-start-missing-schema-dist-"));
		createTypeScriptProject(cwd);
		mkdirSync(join(cwd, "src/routes/status"), { recursive: true });
		writeFileSync(
			join(cwd, "src/routes/status/schemas.ts"),
			`import { z } from "zod";

export const GetStatusResponse = z.object({ ok: z.boolean() });
`,
		);
		writeFileSync(
			join(cwd, "src/routes/status/route.ts"),
			`import { createRoute, createRouteRoot } from "@routa-ts/core";
import { GetStatusResponse } from "./schemas.js";

export default createRouteRoot("/status")({
\tget: createRoute({
\t\tresponses: {
\t\t\tsuccess: {
\t\t\t\tstatus: 200,
\t\t\t\tschema: GetStatusResponse,
\t\t\t},
\t\t},
\t\trun: () => ({ type: "success", data: { ok: true } }),
\t}),
});
`,
		);

		const dev = run(["dev", "--print"], { cwd });
		writeCompiledRuntimeFiles(cwd, [
			"src/routa.ts",
			".routa/routes.gen.ts",
			"src/routes/status/route.ts",
		]);
		const start = run(["start", "--print"], { cwd });

		expect(dev.code).toBe(0);
		expect(start.code).toBe(1);
		expect(start.stderr).toContain(
			"Missing compiled runtime output for src/routes/status/schemas.ts.",
		);
	});

	it("stubs empty route files without overwriting user code", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-route-stub-"));
		createTypeScriptProject(cwd);
		mkdirSync(join(cwd, "src/routes/(private)/users/$userId"), { recursive: true });
		mkdirSync(join(cwd, "src/routes/users"), { recursive: true });
		mkdirSync(join(cwd, "src/routes/status"), { recursive: true });
		writeFileSync(join(cwd, "src/routes/(private)/users/$userId/route.ts"), "");
		writeFileSync(join(cwd, "src/routes/tasks.$taskId.ts"), "");
		writeFileSync(join(cwd, "src/routes/users/route.ts"), "");
		writeFileSync(join(cwd, "src/routes/status/route.ts"), "export default {};\n");

		const written = stubEmptyRouteFiles(cwd);

		expect(written).toHaveLength(3);
		expect(written).toEqual(
			expect.arrayContaining([
				"src/routes/(private)/users/$userId/route.ts",
				"src/routes/tasks.$taskId.ts",
				"src/routes/users/route.ts",
			]),
		);
		expect(readFileSync(join(cwd, "src/routes/users/route.ts"), "utf8")).toContain(
			'import { createRoute, createRouteRoot } from "@routa-ts/core";',
		);
		expect(readFileSync(join(cwd, "src/routes/users/route.ts"), "utf8")).toContain(
			'const route = createRouteRoot("/users");',
		);
		expect(
			readFileSync(join(cwd, "src/routes/(private)/users/$userId/route.ts"), "utf8"),
		).toContain('const route = createRouteRoot("/users/:userId");');
		expect(readFileSync(join(cwd, "src/routes/tasks.$taskId.ts"), "utf8")).toContain(
			'const route = createRouteRoot("/tasks/:taskId");',
		);
		expect(readFileSync(join(cwd, "src/routes/users/route.ts"), "utf8")).toContain("responses: {}");
		expect(readFileSync(join(cwd, "src/routes/status/route.ts"), "utf8")).toBe(
			"export default {};\n",
		);
	});

	it("detects source file changes for dev restarts", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-source-snapshot-"));
		createTypeScriptProject(cwd);
		mkdirSync(join(cwd, "src/routes/status"), { recursive: true });
		writeFileSync(join(cwd, "src/routes/status/route.ts"), "export default {};\n");

		const before = sourceSnapshot(cwd);
		await waitForMtimeTick();
		writeFileSync(join(cwd, "src/routes/status/route.ts"), "export default { get: {} };\n");
		const after = sourceSnapshot(cwd);

		expect(sourceSnapshotChanged(before, after)).toBe(true);
		expect(sourceSnapshotChanged(after, after)).toBe(false);
	});

	it("reports missing success responses before typechecking", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-missing-success-"));
		createTypeScriptProject(cwd);
		mkdirSync(join(cwd, "src/routes/users"), { recursive: true });
		writeFileSync(
			join(cwd, "src/routes/users/route.ts"),
			`import { createRoute, createRouteRoot } from "@routa-ts/core";

export default createRouteRoot("/users")({
\tget: createRoute({
\t\tresponses: {},
\t\trun: async () => ({ type: "success", data: null }),
\t}),
});
`,
		);

		const result = run(["check"], { cwd });

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("ROUTA_MISSING_SUCCESS_RESPONSE");
		expect(result.stderr).toContain("GET /users");
	});

	it("requires DELETE routes to declare a 2xx success response", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-missing-delete-success-"));
		createTypeScriptProject(cwd);
		mkdirSync(join(cwd, "src/routes/users"), { recursive: true });
		writeFileSync(
			join(cwd, "src/routes/users/route.ts"),
			`import { createRoute, createRouteRoot } from "@routa-ts/core";

export default createRouteRoot("/users")({
\tdelete: createRoute({
\t\tresponses: {},
\t\trun: async () => ({ type: "success", data: null }),
\t}),
});
`,
		);

		const result = run(["check"], { cwd });

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("ROUTA_MISSING_SUCCESS_RESPONSE");
		expect(result.stderr).toContain("DELETE /users");
	});

	it("accepts DELETE routes that declare a 204 success response", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-delete-204-"));
		createTypeScriptProject(cwd);
		mkdirSync(join(cwd, "src/routes/users"), { recursive: true });
		writeFileSync(
			join(cwd, "src/routes/users/route.ts"),
			`import { createRoute, createRouteRoot } from "@routa-ts/core";
import { z } from "zod";

export default createRouteRoot("/users")({
\tdelete: createRoute({
\t\tresponses: {
\t\t\tsuccess: {
\t\t\t\tstatus: 204,
\t\t\t\tschema: z.unknown(),
\t\t\t},
\t\t},
\t\trun: async () => ({ type: "success", data: null }),
\t}),
});
`,
		);

		const result = run(["check"], { cwd });

		expect(result.code).toBe(0);
		expect(readFileSync(join(cwd, ".routa/routes.gen.ts"), "utf8")).toContain(
			'"delete": [\n\t\t\t\t204',
		);
	});

	it("records headers and cookies in generated route metadata", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-input-headers-cookies-"));
		createTypeScriptProject(cwd);
		mkdirSync(join(cwd, "src/routes/users"), { recursive: true });
		writeFileSync(
			join(cwd, "src/routes/users/route.ts"),
			`import { createRoute, createRouteRoot } from "@routa-ts/core";
import { z } from "zod";

export default createRouteRoot("/users")({
\tget: createRoute({
\t\tinput: {
\t\t\theaders: z.object({ authorization: z.string() }),
\t\t\tcookies: z.object({ session: z.string() }),
\t\t},
\t\tresponses: {
\t\t\tsuccess: {
\t\t\t\tstatus: 200,
\t\t\t\tschema: z.object({ ok: z.boolean() }),
\t\t\t},
\t\t},
\t\trun: async () => ({ type: "success", data: { ok: true } }),
\t}),
});
`,
		);

		const result = run(["check"], { cwd });

		expect(result.code).toBe(0);
		const metadata = readFileSync(join(cwd, ".routa/routes.gen.ts"), "utf8");
		expect(metadata).toContain('"headers": true');
		expect(metadata).toContain('"cookies": true');
	});

	it("can validate without writing routes.gen.ts", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-validate-no-write-"));
		createTypeScriptProject(cwd);
		mkdirSync(join(cwd, "src/routes/status"), { recursive: true });
		writeFileSync(
			join(cwd, "src/routes/status/route.ts"),
			`import { createRoute, createRouteRoot } from "@routa-ts/core";
import { z } from "zod";

export default createRouteRoot("/status")({
\tget: createRoute({
\t\tresponses: {
\t\t\tsuccess: {
\t\t\t\tstatus: 200,
\t\t\t\tschema: z.object({ ok: z.boolean() }),
\t\t\t},
\t\t},
\t\trun: async () => ({ type: "success", data: { ok: true } }),
\t}),
});
`,
		);

		const validation = validateProject(cwd, { write: false });

		expect(validation.diagnostics).toEqual([]);
		expect(existsSync(join(cwd, ".routa/routes.gen.ts"))).toBe(false);
	});

	it("generates OpenAPI without writing routes.gen.ts", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-openapi-no-write-"));
		createTypeScriptProject(cwd);
		mkdirSync(join(cwd, "src/routes/status"), { recursive: true });
		writeFileSync(
			join(cwd, "src/routes/status/route.ts"),
			`import { createRoute, createRouteRoot } from "@routa-ts/core";
import { z } from "zod";

export default createRouteRoot("/status")({
\tget: createRoute({
\t\tresponses: {
\t\t\tsuccess: {
\t\t\t\tstatus: 200,
\t\t\t\tschema: z.object({ ok: z.boolean() }),
\t\t\t},
\t\t},
\t\trun: async () => ({ type: "success", data: { ok: true } }),
\t}),
});
`,
		);

		const openapi = generateOpenApi(cwd);

		expect(openapi.paths?.["/status"]?.get).toBeDefined();
		expect(existsSync(join(cwd, ".routa/routes.gen.ts"))).toBe(false);
	});

	it("skips symlink cycles while snapshotting source files", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-symlink-cycle-"));
		createTypeScriptProject(cwd);
		mkdirSync(join(cwd, "src/routes/status"), { recursive: true });
		writeFileSync(
			join(cwd, "src/routes/status/route.ts"),
			`import { createRoute, createRouteRoot } from "@routa-ts/core";
import { z } from "zod";

export default createRouteRoot("/status")({
\tget: createRoute({
\t\tresponses: {
\t\t\tsuccess: {
\t\t\t\tstatus: 200,
\t\t\t\tschema: z.object({ ok: z.boolean() }),
\t\t\t},
\t\t},
\t\trun: async () => ({ type: "success", data: { ok: true } }),
\t}),
});
`,
		);
		symlinkSync(join(cwd, "src"), join(cwd, "src/loop"), "dir");

		const snapshot = sourceSnapshot(cwd);

		expect(snapshot.has("src/routes/status/route.ts")).toBe(true);
		expect(snapshot.has("src/routa.ts")).toBe(true);
		expect([...snapshot.keys()].some((file) => file.includes(`${sep}loop${sep}`))).toBe(false);
	});

	it("resolves export default identifiers to route configs", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-route-config-ident-"));
		createTypeScriptProject(cwd);
		mkdirSync(join(cwd, "src/routes/status"), { recursive: true });
		writeFileSync(
			join(cwd, "src/routes/status/route.ts"),
			`import { createRoute, createRouteRoot } from "@routa-ts/core";
import { z } from "zod";

const route = createRouteRoot("/status")({
\tget: createRoute({
\t\tresponses: {
\t\t\tsuccess: {
\t\t\t\tstatus: 200,
\t\t\t\tschema: z.object({ ok: z.boolean() }),
\t\t\t},
\t\t},
\t\trun: async () => ({ type: "success", data: { ok: true } }),
\t}),
});

export default route;
`,
		);

		const result = run(["check"], { cwd });

		expect(result.code).toBe(0);
		expect(readFileSync(join(cwd, ".routa/routes.gen.ts"), "utf8")).toContain('"/status"');
	});

	it("reports unresolved route configs", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-route-config-unresolved-"));
		createTypeScriptProject(cwd);
		mkdirSync(join(cwd, "src/routes/status"), { recursive: true });
		writeFileSync(
			join(cwd, "src/routes/status/route.ts"),
			`const route = missingFactory();
export default route;
`,
		);

		const result = run(["check"], { cwd });

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("ROUTA_ROUTE_CONFIG_UNRESOLVED");
	});

	it("rejects legacy route config helpers", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-legacy-route-config-"));
		createTypeScriptProject(cwd);
		mkdirSync(join(cwd, "src/routes/status"), { recursive: true });
		writeFileSync(
			join(cwd, "src/routes/status/route.ts"),
			`const legacyRoute = (config: unknown) => config;

export default legacyRoute({});
`,
		);

		const result = run(["check"], { cwd });

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("ROUTA_ROUTE_CONFIG_UNRESOLVED");
		expect(result.stderr).toContain('createRouteRoot("/status")');
	});

	it("rejects explicit OPTIONS route contracts", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-explicit-options-"));
		createTypeScriptProject(cwd);
		mkdirSync(join(cwd, "src/routes/status"), { recursive: true });
		writeFileSync(
			join(cwd, "src/routes/status/route.ts"),
			`import { createRoute, createRouteRoot } from "@routa-ts/core";
import { z } from "zod";

export default createRouteRoot("/status")({
	options: createRoute({
		responses: { success: { status: 204, schema: z.null() } },
		run: () => ({ type: "success", data: null }),
	}),
});
`,
		);

		const result = run(["check"], { cwd });

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("ROUTA_OPTIONS_AUTOMATIC");
		expect(result.stderr).toContain("Remove the options contract");
	});

	it("reports duplicate schema exports with Routa diagnostics", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-duplicate-schema-"));
		createTypeScriptProject(cwd);
		mkdirSync(join(cwd, "src/routes/users"), { recursive: true });
		writeFileSync(
			join(cwd, "src/routes/users/route.ts"),
			`import { createRouteRoot } from "@routa-ts/core";

export default createRouteRoot("/users")({});
`,
		);
		writeFileSync(
			join(cwd, "src/routes/users/schemas.ts"),
			`export const UserResponse = {};
export const UserResponse = {};
`,
		);

		const result = run(["check"], { cwd });

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("ROUTA_DUPLICATE_SCHEMA_NAME");
		expect(result.stderr).toContain("UserResponse");
	});

	it("scaffolds collection routes from OpenAPI YAML", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-scaffold-yaml-"));
		createTypeScriptProject(cwd);
		writeFileSync(
			join(cwd, "openapi.yaml"),
			`openapi: 3.1.0
info:
  title: Users API
  version: 0.0.0
paths:
  /users:
    get:
      operationId: listUsers
      responses:
        "200":
          description: Users
          content:
            application/json:
              schema:
                type: array
                items:
                  type: object
                  required:
                    - id
                  properties:
                    id:
                      type: string
    post:
      operationId: createUser
      requestBody:
        content:
          application/json:
            schema:
              type: object
              required:
                - name
              properties:
                name:
                  type: string
      responses:
        "201":
          description: Created user
          content:
            application/json:
              schema:
                type: object
                required:
                  - id
                properties:
                  id:
                    type: string
`,
		);

		const result = run(["scaffold", "openapi.yaml"], { cwd });

		expect(result.code).toBe(0);
		expect(readFileSync(join(cwd, "src/routes/users/route.ts"), "utf8")).toContain(
			"get: createRoute",
		);
		expect(readFileSync(join(cwd, "src/routes/users/route.ts"), "utf8")).toContain(
			"post: createRoute",
		);
		expect(readFileSync(join(cwd, "src/routes/users/route.ts"), "utf8")).toContain(
			'data: { id: "" }',
		);
		expect(readFileSync(join(cwd, "src/routes/users/schemas.ts"), "utf8")).toContain(
			"export const CreateUserBody",
		);
		expect(readFileSync(join(cwd, ".routa/manifest.json"), "utf8")).toContain("listUsers");
		expect(readFileSync(join(cwd, ".routa/routes.gen.ts"), "utf8")).toContain('"/users"');
	});

	it("scaffolds item params from OpenAPI JSON", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-scaffold-json-"));
		createTypeScriptProject(cwd);
		writeFileSync(
			join(cwd, "openapi.json"),
			JSON.stringify({
				openapi: "3.1.0",
				info: { title: "Users API", version: "0.0.0" },
				paths: {
					"/users/{id}": {
						get: {
							operationId: "getUserById",
							parameters: [{ name: "id", in: "path", required: true, schema: { type: "string" } }],
							responses: {
								"200": {
									description: "User",
									content: { "application/json": { schema: { type: "object" } } },
								},
							},
						},
					},
				},
			}),
		);

		const result = run(["scaffold", "openapi.json"], { cwd });

		expect(result.code).toBe(0);
		expect(readFileSync(join(cwd, "src/routes/users/$id/route.ts"), "utf8")).toContain(
			"params: GetUserByIdParams",
		);
		expect(readFileSync(join(cwd, "src/routes/users/$id/schemas.ts"), "utf8")).toContain(
			"id: z.string()",
		);
	});

	it("accepts absolute OpenAPI input paths", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-scaffold-absolute-"));
		createTypeScriptProject(cwd);
		const input = join(cwd, "openapi.yaml");
		writeFileSync(
			input,
			`openapi: 3.1.0
info:
  title: Users API
  version: 0.0.0
paths:
  /status:
    get:
      operationId: getStatus
      responses:
        "200":
          description: Status
`,
		);

		const result = run(["scaffold", input], { cwd });

		expect(result.code).toBe(0);
		expect(existsSync(join(cwd, "src/routes/status/route.ts"))).toBe(true);
	});

	it("scaffolds path-item parameters into operation input", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-scaffold-path-item-params-"));
		createTypeScriptProject(cwd);
		writeOpenApiPaths(
			cwd,
			`  /users/{id}:
    parameters:
      - name: id
        in: path
        required: true
        schema:
          type: string
    get:
      operationId: getUser
      responses:
        "200":
          description: User
`,
		);

		const result = run(["scaffold", "openapi.yaml"], { cwd });
		const route = readFileSync(join(cwd, "src/routes/users/$id/route.ts"), "utf8");
		const schemas = readFileSync(join(cwd, "src/routes/users/$id/schemas.ts"), "utf8");

		expect(result.code).toBe(0);
		expect(route).toContain("params: GetUserParams");
		expect(schemas).toContain("export const GetUserParams = z.object({");
		expect(schemas).toContain("id: z.string()");
	});

	it("explains malformed OpenAPI parameters without throwing raw type errors", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-scaffold-bad-params-"));
		createTypeScriptProject(cwd);
		writeOpenApiPaths(
			cwd,
			`  /users/{id}:
    parameters:
      id:
        in: path
    get:
      operationId: getUser
      responses:
        "200":
          description: User
`,
		);

		const result = run(["scaffold", "openapi.yaml"], { cwd });

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("ROUTA_OPENAPI_INVALID_PARAMETERS");
		expect(result.stderr).toContain("Path-level parameters for /users/{id} must be an array.");
	});

	it("preserves multiple successful scaffold responses", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-scaffold-multi-success-"));
		createTypeScriptProject(cwd);
		writeOpenApiPaths(
			cwd,
			`  /reports:
    post:
      operationId: createReport
      responses:
        "201":
          description: Created report
          content:
            application/json:
              schema:
                type: object
                required:
                  - id
                properties:
                  id:
                    type: string
        "202":
          description: Accepted report
          content:
            application/json:
              schema:
                type: object
                required:
                  - queued
                properties:
                  queued:
                    type: boolean
`,
		);

		const result = run(["scaffold", "openapi.yaml"], { cwd });
		const route = readFileSync(join(cwd, "src/routes/reports/route.ts"), "utf8");
		const schemas = readFileSync(join(cwd, "src/routes/reports/schemas.ts"), "utf8");

		expect(result.code).toBe(0);
		expect(route).toContain("success: {");
		expect(route).toContain("status: 201");
		expect(route).toContain("success202: {");
		expect(route).toContain("status: 202");
		expect(route).toContain("schema: CreateReportResponse201");
		expect(route).toContain("schema: CreateReportResponse202");
		expect(schemas).toContain("export const CreateReportResponse201 = z.object({");
		expect(schemas).toContain("export const CreateReportResponse202 = z.object({");
	});

	it("preserves component ref schema identity", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-component-ref-"));
		createTypeScriptProject(cwd);
		writeFileSync(
			join(cwd, "openapi.yaml"),
			`openapi: 3.1.0
info:
  title: Users API
  version: 0.0.0
paths:
  /users/{id}:
    get:
      operationId: getUser
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
      responses:
        "200":
          description: User
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/User"
components:
  schemas:
    User:
      type: object
      required:
        - id
      properties:
        id:
          type: string
`,
		);

		const result = run(["scaffold", "openapi.yaml"], { cwd });

		expect(result.code).toBe(0);
		const schemas = readFileSync(join(cwd, "src/routes/users/$id/schemas.ts"), "utf8");
		expect(schemas).toContain("export const User = z.object");
		expect(schemas).toContain("export const GetUserResponse = User");
	});

	it("rejects unsupported scaffold input before writing files", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-scaffold-txt-"));
		createTypeScriptProject(cwd);
		writeFileSync(join(cwd, "openapi.txt"), "not supported");

		const result = run(["scaffold", "openapi.txt"], { cwd });

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("Unsupported OpenAPI input");
	});

	it("reports missing OpenAPI input files with next steps", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-openapi-missing-file-"));
		createTypeScriptProject(cwd);

		const result = run(["scaffold", "missing.yaml"], { cwd });

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("ROUTA_OPENAPI_FILE_NOT_FOUND");
		expect(result.stderr).toContain("Could not find missing.yaml");
		expect(result.stderr).toContain("Run this command from the project root");
	});

	it("accepts .yml OpenAPI input files", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-scaffold-yml-"));
		createTypeScriptProject(cwd);
		writeFileSync(join(cwd, "openapi.yml"), simpleUsersOpenApi());

		const result = run(["scaffold", "openapi.yml"], { cwd });

		expect(result.code).toBe(0);
		expect(existsSync(join(cwd, "src/routes/users/route.ts"))).toBe(true);
	});

	it("explains when an OpenAPI paths fragment is missing the root paths object", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-openapi-fragment-"));
		createTypeScriptProject(cwd);
		writeFileSync(
			join(cwd, "openapi.yaml"),
			`  /users:
    get:
      operationId: listUsers
      responses:
        "200":
          description: Users
`,
		);

		const result = run(["scaffold", "openapi.yaml"], { cwd });

		expect(result.code).toBe(1);
		expect(result.stderr).toContain(
			'ROUTA_OPENAPI_MISSING_PATHS: openapi.yaml is missing the required top-level "paths" object.',
		);
		expect(result.stderr).toContain('Found path-like root key "/users".');
		expect(result.stderr).toContain(
			"Those route definitions need to be nested under top-level paths:",
		);
		expect(result.stderr).toContain("paths:");
		expect(result.stderr).toContain("  /users:");
		expect(existsSync(join(cwd, "src/routes/users/route.ts"))).toBe(false);
	});

	it("reports OpenAPI YAML parser errors with file context", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-openapi-yaml-error-"));
		createTypeScriptProject(cwd);
		writeFileSync(join(cwd, "openapi.yaml"), "openapi: [\n");

		const result = run(["scaffold", "openapi.yaml"], { cwd });

		expect(result.code).toBe(1);
		expect(result.stderr).toContain(
			"ROUTA_OPENAPI_PARSE_ERROR: openapi.yaml could not be parsed as YAML.",
		);
		expect(result.stderr).toContain("Parser error:");
	});

	it("explains when paths is not an object", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-openapi-invalid-paths-"));
		createTypeScriptProject(cwd);
		writeFileSync(
			join(cwd, "openapi.yaml"),
			`openapi: 3.1.0
info:
  title: Users API
  version: 0.0.0
paths: []
`,
		);

		const result = run(["scaffold", "openapi.yaml"], { cwd });

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("ROUTA_OPENAPI_INVALID_PATHS");
		expect(result.stderr).toContain('"paths" must be an object');
	});

	it("explains missing OpenAPI version and info metadata", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-openapi-root-metadata-"));
		createTypeScriptProject(cwd);
		writeFileSync(
			join(cwd, "openapi.yaml"),
			`info:
  title: Users API
  version: 0.0.0
paths:
  /users:
    get:
      operationId: listUsers
      responses:
        "200":
          description: Users
`,
		);

		const missingVersion = run(["scaffold", "openapi.yaml"], { cwd });
		expect(missingVersion.code).toBe(1);
		expect(missingVersion.stderr).toContain("ROUTA_OPENAPI_MISSING_OPENAPI_VERSION");

		writeFileSync(
			join(cwd, "openapi.yaml"),
			`openapi: 3.1.0
paths:
  /users:
    get:
      operationId: listUsers
      responses:
        "200":
          description: Users
`,
		);

		const missingInfo = run(["scaffold", "openapi.yaml"], { cwd });
		expect(missingInfo.code).toBe(1);
		expect(missingInfo.stderr).toContain("ROUTA_OPENAPI_MISSING_INFO");
		expect(missingInfo.stderr).toContain("info:");
	});

	it("explains invalid path keys and unsupported methods", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-openapi-path-method-"));
		createTypeScriptProject(cwd);
		writeOpenApiPaths(
			cwd,
			`  users:
    get:
      operationId: listUsers
      responses:
        "200":
          description: Users
`,
		);

		const invalidPath = run(["scaffold", "openapi.yaml"], { cwd });
		expect(invalidPath.code).toBe(1);
		expect(invalidPath.stderr).toContain("ROUTA_OPENAPI_INVALID_PATH_KEY");
		expect(invalidPath.stderr).toContain('Use "/users" instead of "users"');

		writeOpenApiPaths(
			cwd,
			`  /users:
    GET:
      operationId: listUsers
      responses:
        "200":
          description: Users
`,
		);

		const uppercaseMethod = run(["scaffold", "openapi.yaml"], { cwd });
		expect(uppercaseMethod.code).toBe(1);
		expect(uppercaseMethod.stderr).toContain("ROUTA_OPENAPI_UNSUPPORTED_METHOD");
		expect(uppercaseMethod.stderr).toContain('Use lowercase "get" instead of "GET"');

		writeOpenApiPaths(
			cwd,
			`  /users:
    gets:
      operationId: listUsers
      responses:
        "200":
          description: Users
`,
		);

		const typoMethod = run(["scaffold", "openapi.yaml"], { cwd });
		expect(typoMethod.code).toBe(1);
		expect(typoMethod.stderr).toContain("Allowed methods: get, post, put");
	});

	it("scaffolds coercing parameter schemas and lowercases header names", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-openapi-param-coercion-"));
		createTypeScriptProject(cwd);
		writeOpenApiPaths(
			cwd,
			`  /items:
    get:
      operationId: listItems
      parameters:
        - name: limit
          in: query
          required: false
          schema:
            type: integer
        - name: archived
          in: query
          required: false
          schema:
            type: boolean
        - name: X-Request-Id
          in: header
          required: true
          schema:
            type: string
      responses:
        "200":
          description: Items
          content:
            application/json:
              schema:
                type: object
                required:
                  - ok
                properties:
                  ok:
                    type: boolean
`,
		);

		const scaffold = run(["scaffold", "openapi.yaml"], { cwd });
		expect(scaffold.code).toBe(0);

		const schemas = readFileSync(join(cwd, "src/routes/items/schemas.ts"), "utf8");
		expect(schemas).toContain("limit: z.coerce.number().int().optional()");
		expect(schemas).toContain("archived: z.stringbool().optional()");
		expect(schemas).toContain('"x-request-id": z.string()');

		const drift = run(["openapi", "check"], { cwd });
		expect(drift.code).toBe(0);
		expect(drift.stdout).toContain("No drift detected");
	});

	it("rejects structured parameter schemas that cannot arrive as strings", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-openapi-param-structured-"));
		createTypeScriptProject(cwd);
		writeOpenApiPaths(
			cwd,
			`  /items:
    get:
      operationId: listItems
      parameters:
        - name: tags
          in: query
          required: false
          schema:
            type: array
            items:
              type: string
      responses:
        "200":
          description: Items
          content:
            application/json:
              schema:
                type: object
                properties:
                  ok:
                    type: boolean
`,
		);

		const result = run(["scaffold", "openapi.yaml"], { cwd });

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("ROUTA_OPENAPI_UNSUPPORTED_PARAMETER_SCHEMA");
		expect(result.stderr).toContain("tags");
	});

	it("scaffolds route metadata that routa check reproduces byte-for-byte", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-scaffold-metadata-stable-"));
		createTypeScriptProject(cwd);
		writeSimpleUsersOpenApi(cwd);
		run(["scaffold", "openapi.yaml"], { cwd });

		const scaffolded = readFileSync(join(cwd, ".routa/routes.gen.ts"), "utf8");
		expect(scaffolded).toContain('"methodMiddleware"');
		expect(scaffolded).toContain('"responses"');

		const validation = validateProject(cwd);

		expect(validation.diagnostics).toEqual([]);
		expect(readFileSync(join(cwd, ".routa/routes.gen.ts"), "utf8")).toBe(scaffolded);
	});

	it("creates starter metadata that routa check reproduces byte-for-byte", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-create-metadata-stable-"));

		const result = await run(["create", "my-api", "--no-git", "--no-install"], { cwd });
		expect(result.code).toBe(0);

		const projectDir = join(cwd, "my-api");
		const created = readFileSync(join(projectDir, ".routa/routes.gen.ts"), "utf8");
		const validation = validateProject(projectDir);

		expect(validation.diagnostics).toEqual([]);
		expect(readFileSync(join(projectDir, ".routa/routes.gen.ts"), "utf8")).toBe(created);
	});

	it("round-trips widened schema shapes through scaffold and drift check", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-openapi-widened-"));
		createTypeScriptProject(cwd);
		writeOpenApiPaths(
			cwd,
			`  /widgets:
    get:
      operationId: listWidgets
      responses:
        "200":
          description: Widgets
          content:
            application/json:
              schema:
                type: object
                required:
                  - status
                  - labels
                  - contact
                  - createdAt
                properties:
                  status:
                    const: active
                  labels:
                    type: object
                    additionalProperties:
                      type: string
                  contact:
                    type: string
                    format: email
                  nickname:
                    type:
                      - string
                      - "null"
                  size:
                    anyOf:
                      - type: string
                      - type: integer
                  createdAt:
                    type: string
                    format: date-time
`,
		);

		const scaffold = run(["scaffold", "openapi.yaml"], { cwd });
		expect(scaffold.code).toBe(0);

		const schemas = readFileSync(join(cwd, "src/routes/widgets/schemas.ts"), "utf8");
		expect(schemas).toContain('status: z.literal("active")');
		expect(schemas).toContain("labels: z.record(z.string(), z.string())");
		expect(schemas).toContain("contact: z.email()");
		expect(schemas).toContain("nickname: z.string().nullable().optional()");
		expect(schemas).toContain("size: z.union([z.string(), z.int()]).optional()");
		expect(schemas).toContain("createdAt: z.iso.datetime()");

		const drift = run(["openapi", "check"], { cwd });
		expect(drift.code).toBe(0);
		expect(drift.stdout).toContain("No drift detected");
	});

	it("keeps drift checks clean when users add zod refinement chains", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-openapi-refined-"));
		createTypeScriptProject(cwd);
		writeSimpleUsersOpenApi(cwd);
		run(["scaffold", "openapi.yaml"], { cwd });

		const schemaFile = join(cwd, "src/routes/users/schemas.ts");
		const schemas = readFileSync(schemaFile, "utf8");
		writeFileSync(
			schemaFile,
			schemas.replace(
				"name: z.string()",
				'name: z.string().min(1).max(80).trim().regex(/^[^\\d]/).describe("Display name")',
			),
		);

		const drift = run(["openapi", "check"], { cwd });
		expect(drift.code).toBe(0);
		expect(drift.stdout).toContain("No drift detected");
	});

	it("matches golden output for scaffolded route and schema files", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-scaffold-golden-"));
		createTypeScriptProject(cwd);
		writeOpenApiPaths(
			cwd,
			`  /users/{id}:
    get:
      operationId: getUser
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
        - name: verbose
          in: query
          required: false
          schema:
            type: boolean
      responses:
        "200":
          description: A user
          content:
            application/json:
              schema:
                type: object
                required:
                  - id
                properties:
                  id:
                    type: string
        "404":
          description: Not found
          content:
            application/json:
              schema:
                type: object
                properties:
                  message:
                    type: string
    delete:
      operationId: deleteUser
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
      responses:
        "204":
          description: Deleted
`,
		);

		const result = run(["scaffold", "openapi.yaml"], { cwd });
		expect(result.code).toBe(0);

		expect(readFileSync(join(cwd, "src/routes/users/$id/route.ts"), "utf8")).toMatchSnapshot(
			"golden route.ts",
		);
		expect(readFileSync(join(cwd, "src/routes/users/$id/schemas.ts"), "utf8")).toMatchSnapshot(
			"golden schemas.ts",
		);
		expect(readFileSync(join(cwd, ".routa/routes.gen.ts"), "utf8")).toMatchSnapshot(
			"golden routes.gen.ts",
		);
	});

	it("reports undeclared response variants in consumer projects", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-consumer-compile-fail-"));
		createTypeScriptProject(cwd);
		mkdirSync(join(cwd, "src/routes/status"), { recursive: true });
		writeFileSync(
			join(cwd, "src/routes/status/route.ts"),
			`import { createRoute, createRouteRoot } from "@routa-ts/core";
import { z } from "zod";

export default createRouteRoot("/status")({
\tget: createRoute({
\t\tresponses: {
\t\t\tsuccess: {
\t\t\t\tstatus: 200,
\t\t\t\tschema: z.object({ ok: z.boolean() }),
\t\t\t},
\t\t},
\t\trun: () => ({ type: "undeclaredVariant", data: { ok: true } }),
\t}),
});
`,
		);

		const result = run(["check"], { cwd });

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("ROUTA_RESULT_TYPE");
		expect(result.stderr).toContain("undeclaredVariant");
	});

	it("reports extra fields in route run results", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-result-shape-"));
		createTypeScriptProject(cwd);
		mkdirSync(join(cwd, "src/routes/status"), { recursive: true });
		writeFileSync(
			join(cwd, "src/routes/status/route.ts"),
			`import { createRoute, createRouteRoot } from "@routa-ts/core";
import { z } from "zod";

export default createRouteRoot("/status")({
\tget: createRoute({
\t\tresponses: {
\t\t\tsuccess: {
\t\t\t\tstatus: 200,
\t\t\t\tschema: z.object({ ok: z.boolean() }),
\t\t\t},
\t\t},
\t\trun: () => {
\t\t\treturn {
\t\t\t\ttype: "success",
\t\t\t\ttimestamp: new Date().toISOString(),
\t\t\t\tdata: { ok: true },
\t\t\t};
\t\t},
\t}),
});
`,
		);

		const result = run(["check"], { cwd });

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("ROUTA_RESULT_SHAPE");
		expect(result.stderr).toContain('unsupported field "timestamp"');
		expect(result.stderr).toContain("src/routes/status/route.ts");
	});

	it("reports undeclared route run result types", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-result-type-"));
		createTypeScriptProject(cwd);
		mkdirSync(join(cwd, "src/routes/status"), { recursive: true });
		writeFileSync(
			join(cwd, "src/routes/status/route.ts"),
			`import { createRoute, createRouteRoot } from "@routa-ts/core";
import { z } from "zod";

export default createRouteRoot("/status")({
\tget: createRoute({
\t\tresponses: {
\t\t\tsuccess: {
\t\t\t\tstatus: 200,
\t\t\t\tschema: z.object({ ok: z.boolean() }),
\t\t\t},
\t\t},
\t\trun: () => ({
\t\t\ttype: "succes",
\t\t\tdata: { ok: true },
\t\t}),
\t}),
});
`,
		);

		const result = run(["check"], { cwd });

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("ROUTA_RESULT_TYPE");
		expect(result.stderr).toContain('Run result type "succes" is not declared');
		expect(result.stderr).toContain('Use one of the declared result types: "success"');
	});

	it("reports undeclared middleware run result types", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-middleware-result-type-"));
		createTypeScriptProject(cwd);
		mkdirSync(join(cwd, "src/routes"), { recursive: true });
		writeFileSync(
			join(cwd, "src/routes/middleware.ts"),
			`import { createMiddleware } from "@routa-ts/core";
import { z } from "zod";

export const requireAuth = createMiddleware({
\trejects: {
\t\tunauthorized: {
\t\t\tstatus: 401,
\t\t\tschema: z.object({ message: z.string() }),
\t\t},
\t},
\trun: () => ({
\t\ttype: "unauthorize",
\t\tdata: { message: "Missing session" },
\t}),
});
`,
		);

		const result = run(["check"], { cwd });

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("ROUTA_RESULT_TYPE");
		expect(result.stderr).toContain('Run result type "unauthorize" is not declared');
		expect(result.stderr).toContain('Use one of the declared result types: "unauthorized"');
	});

	it("rejects path keys with dot segments that would escape the project", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-openapi-traversal-"));
		createTypeScriptProject(cwd);
		writeOpenApiPaths(
			cwd,
			`  /../../outside/evil:
    get:
      operationId: escapeProject
      responses:
        "200":
          description: Escape
`,
		);

		const traversal = run(["scaffold", "openapi.yaml"], { cwd });
		expect(traversal.code).toBe(1);
		expect(traversal.stderr).toContain("ROUTA_OPENAPI_UNSAFE_PATH_SEGMENT");
		expect(existsSync(join(cwd, "..", "outside"))).toBe(false);

		writeOpenApiPaths(
			cwd,
			`  "/users/back\\\\slash":
    get:
      operationId: backslashSegment
      responses:
        "200":
          description: Backslash
`,
		);

		const backslash = run(["scaffold", "openapi.yaml"], { cwd });
		expect(backslash.code).toBe(1);
		expect(backslash.stderr).toContain("ROUTA_OPENAPI_UNSAFE_PATH_SEGMENT");
	});

	it("explains operations and responses that cannot be scaffolded", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-openapi-operation-response-"));
		createTypeScriptProject(cwd);
		writeOpenApiPaths(
			cwd,
			`  /users:
    get: listUsers
`,
		);

		const invalidOperation = run(["scaffold", "openapi.yaml"], { cwd });
		expect(invalidOperation.code).toBe(1);
		expect(invalidOperation.stderr).toContain("ROUTA_OPENAPI_INVALID_OPERATION");

		writeOpenApiPaths(
			cwd,
			`  /users:
    get:
      operationId: listUsers
`,
		);

		const missingResponses = run(["scaffold", "openapi.yaml"], { cwd });
		expect(missingResponses.code).toBe(1);
		expect(missingResponses.stderr).toContain("ROUTA_OPENAPI_MISSING_RESPONSES");

		writeOpenApiPaths(
			cwd,
			`  /users:
    get:
      operationId: listUsers
      responses:
        default:
          description: Users
`,
		);

		const invalidStatus = run(["scaffold", "openapi.yaml"], { cwd });
		expect(invalidStatus.code).toBe(1);
		expect(invalidStatus.stderr).toContain("ROUTA_OPENAPI_INVALID_RESPONSE_STATUS");
		expect(invalidStatus.stderr).toContain("Use explicit numeric HTTP status strings");
	});

	it("explains path parameter mismatches", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-openapi-path-params-"));
		createTypeScriptProject(cwd);
		writeOpenApiPaths(
			cwd,
			`  /users/{id}:
    get:
      operationId: getUser
      responses:
        "200":
          description: User
`,
		);

		const missingParam = run(["scaffold", "openapi.yaml"], { cwd });
		expect(missingParam.code).toBe(1);
		expect(missingParam.stderr).toContain("ROUTA_OPENAPI_MISSING_PATH_PARAMETER");
		expect(missingParam.stderr).toContain('missing path parameter "id"');

		writeOpenApiPaths(
			cwd,
			`  /users:
    get:
      operationId: listUsers
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
      responses:
        "200":
          description: Users
`,
		);

		const unusedParam = run(["scaffold", "openapi.yaml"], { cwd });
		expect(unusedParam.code).toBe(1);
		expect(unusedParam.stderr).toContain("ROUTA_OPENAPI_UNUSED_PATH_PARAMETER");
		expect(unusedParam.stderr).toContain('Path parameter "id" is declared but not used');

		writeOpenApiPaths(
			cwd,
			`  /users/{id}:
    get:
      operationId: getUser
      parameters:
        - name: id
          in: path
          schema:
            type: string
      responses:
        "200":
          description: User
`,
		);

		const optionalParam = run(["scaffold", "openapi.yaml"], { cwd });
		expect(optionalParam.code).toBe(1);
		expect(optionalParam.stderr).toContain("ROUTA_OPENAPI_PATH_PARAMETER_REQUIRED");
	});

	it("explains malformed request and response content", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-openapi-content-"));
		createTypeScriptProject(cwd);
		writeOpenApiPaths(
			cwd,
			`  /users:
    post:
      operationId: createUser
      requestBody:
        content: []
      responses:
        "201":
          description: Created
`,
		);

		const invalidRequest = run(["scaffold", "openapi.yaml"], { cwd });
		expect(invalidRequest.code).toBe(1);
		expect(invalidRequest.stderr).toContain("ROUTA_OPENAPI_INVALID_REQUEST_BODY");

		writeOpenApiPaths(
			cwd,
			`  /users:
    get:
      operationId: listUsers
      responses:
        "200":
          description: Users
          content: []
`,
		);

		const invalidResponse = run(["scaffold", "openapi.yaml"], { cwd });
		expect(invalidResponse.code).toBe(1);
		expect(invalidResponse.stderr).toContain("ROUTA_OPENAPI_INVALID_RESPONSE_CONTENT");
	});

	it("explains unsupported schemas and refs", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-openapi-schema-ref-"));
		createTypeScriptProject(cwd);
		writeOpenApiPaths(
			cwd,
			`  /users:
    get:
      operationId: listUsers
      responses:
        "200":
          description: Users
          content:
            application/json:
              schema:
                oneOf:
                  - type: string
`,
		);

		const oneOf = run(["scaffold", "openapi.yaml"], { cwd });
		expect(oneOf.code).toBe(1);
		expect(oneOf.stderr).toContain("ROUTA_OPENAPI_UNSUPPORTED_SCHEMA");
		expect(oneOf.stderr).toContain("oneOf and allOf are not supported");

		writeOpenApiPaths(
			cwd,
			`  /users:
    get:
      operationId: listUsers
      responses:
        "200":
          description: Users
          content:
            application/json:
              schema:
                type: object
                properties:
                  name:
                    type: string
                additionalProperties:
                  type: string
`,
		);

		const additionalProperties = run(["scaffold", "openapi.yaml"], { cwd });
		expect(additionalProperties.code).toBe(1);
		expect(additionalProperties.stderr).toContain("additionalProperties is only supported");

		writeOpenApiPaths(
			cwd,
			`  /users:
    get:
      operationId: listUsers
      responses:
        "200":
          description: Users
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/MissingUser"
`,
		);

		const missingRef = run(["scaffold", "openapi.yaml"], { cwd });
		expect(missingRef.code).toBe(1);
		expect(missingRef.stderr).toContain("ROUTA_OPENAPI_MISSING_REF");
		expect(missingRef.stderr).toContain("#/components/schemas/MissingUser");

		writeOpenApiPaths(
			cwd,
			`  /users:
    get:
      operationId: listUsers
      responses:
        "200":
          description: Users
          content:
            application/json:
              schema:
                type: ["object"]
                properties:
                  name:
                    oneOf:
                      - type: string
`,
		);

		const typeArraySingle = run(["scaffold", "openapi.yaml"], { cwd });
		expect(typeArraySingle.code).toBe(1);
		expect(typeArraySingle.stderr).toContain("ROUTA_OPENAPI_UNSUPPORTED_SCHEMA");
		expect(typeArraySingle.stderr).toContain("oneOf and allOf are not supported");

		writeOpenApiPaths(
			cwd,
			`  /users:
    get:
      operationId: listUsers
      responses:
        "200":
          description: Users
          content:
            application/json:
              schema:
                type: ["object", "null"]
                properties:
                  name:
                    oneOf:
                      - type: string
`,
		);

		const typeArrayNullable = run(["scaffold", "openapi.yaml"], { cwd });
		expect(typeArrayNullable.code).toBe(1);
		expect(typeArrayNullable.stderr).toContain("ROUTA_OPENAPI_UNSUPPORTED_SCHEMA");
		expect(typeArrayNullable.stderr).toContain("oneOf and allOf are not supported");

		writeOpenApiPaths(
			cwd,
			`  /users:
    get:
      operationId: listUsers
      responses:
        "200":
          description: Users
          content:
            application/json:
              schema:
                $ref: "./schemas.yaml#/User"
`,
		);

		const unsupportedRef = run(["scaffold", "openapi.yaml"], { cwd });
		expect(unsupportedRef.code).toBe(1);
		expect(unsupportedRef.stderr).toContain("ROUTA_OPENAPI_UNSUPPORTED_REF");
		expect(unsupportedRef.stderr).toContain("#/components/schemas/User");
	});

	it("explains when no supported operations are present", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-openapi-no-ops-"));
		createTypeScriptProject(cwd);
		writeOpenApiPaths(
			cwd,
			`  /users:
    parameters: []
`,
		);

		const result = run(["scaffold", "openapi.yaml"], { cwd });

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("ROUTA_OPENAPI_NO_SUPPORTED_OPERATIONS");
		expect(result.stderr).toContain("Add at least one supported HTTP method");
	});

	it("rejects OpenAPI operations without operationId", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-missing-operation-id-"));
		createTypeScriptProject(cwd);
		writeFileSync(
			join(cwd, "openapi.yaml"),
			`openapi: 3.1.0
info:
  title: Users API
  version: 0.0.0
paths:
  /users:
    get:
      responses:
        "200":
          description: Users
`,
		);

		const result = run(["scaffold", "openapi.yaml"], { cwd });

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("ROUTA_OPENAPI_MISSING_OPERATION_ID");
		expect(result.stderr).toContain("operationId: getUsers");
	});

	it("rejects duplicate operationIds", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-duplicate-operation-id-"));
		createTypeScriptProject(cwd);
		writeFileSync(
			join(cwd, "openapi.yaml"),
			`openapi: 3.1.0
info:
  title: Users API
  version: 0.0.0
paths:
  /users:
    get:
      operationId: users
      responses:
        "200":
          description: Users
  /admins:
    get:
      operationId: users
      responses:
        "200":
          description: Admins
`,
		);

		const result = run(["scaffold", "openapi.yaml"], { cwd });

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("ROUTA_OPENAPI_DUPLICATE_OPERATION_ID");
		expect(result.stderr).toContain("First used by GET /users");
		expect(result.stderr).toContain("Also used by GET /admins");
	});

	it("rejects generated names that are not valid TypeScript identifiers", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-invalid-identifier-"));
		createTypeScriptProject(cwd);
		writeFileSync(
			join(cwd, "openapi.yaml"),
			`openapi: 3.1.0
info:
  title: Users API
  version: 0.0.0
paths:
  /users:
    get:
      operationId: listUsers
      responses:
        "200":
          description: Users
          content:
            application/json:
              schema:
                $ref: "#/components/schemas/123 bad name"
components:
  schemas:
    "123 bad name":
      type: object
`,
		);

		const result = run(["scaffold", "openapi.yaml"], { cwd });

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("ROUTA_OPENAPI_INVALID_TYPESCRIPT_IDENTIFIER");
		expect(result.stderr).toContain("123BadName");
	});

	it("rejects unsupported OpenAPI media types before writing files", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-unsupported-media-type-"));
		createTypeScriptProject(cwd);
		writeFileSync(
			join(cwd, "openapi.yaml"),
			`openapi: 3.1.0
info:
  title: Users API
  version: 0.0.0
paths:
  /users:
    post:
      operationId: createUser
      requestBody:
        content:
          text/plain:
            schema:
              type: string
      responses:
        "201":
          description: Created
`,
		);

		const result = run(["scaffold", "openapi.yaml"], { cwd });

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("Unsupported request media type");
	});

	it("rejects mixed unsupported OpenAPI media types before writing files", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-mixed-media-type-"));
		createTypeScriptProject(cwd);
		writeFileSync(
			join(cwd, "openapi.yaml"),
			`openapi: 3.1.0
info:
  title: Users API
  version: 0.0.0
paths:
  /users:
    post:
      operationId: createUser
      requestBody:
        content:
          application/json:
            schema:
              type: object
          text/plain:
            schema:
              type: string
      responses:
        "201":
          description: Created
`,
		);

		const result = run(["scaffold", "openapi.yaml"], { cwd });

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("Unsupported request media type");
		expect(existsSync(join(cwd, "src/routes/users/route.ts"))).toBe(false);
	});

	it("rejects GET request bodies before writing scaffold files", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-get-body-"));
		createTypeScriptProject(cwd);
		writeFileSync(
			join(cwd, "openapi.yaml"),
			`openapi: 3.1.0
info:
  title: Users API
  version: 0.0.0
paths:
  /users:
    get:
      operationId: listUsers
      requestBody:
        content:
          application/json:
            schema:
              type: object
      responses:
        "200":
          description: Users
`,
		);

		const result = run(["scaffold", "openapi.yaml"], { cwd });

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("GET /users cannot declare a request body");
		expect(existsSync(join(cwd, "src/routes/users/route.ts"))).toBe(false);
	});

	it("rejects explicit OPTIONS operations in scaffold input", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-scaffold-options-"));
		createTypeScriptProject(cwd);
		writeFileSync(
			join(cwd, "openapi.yaml"),
			`openapi: 3.1.0
info:
  title: Users API
  version: 0.0.0
paths:
  /users:
    options:
      operationId: userOptions
      responses:
        "204":
          description: Automatically generated
`,
		);

		const result = run(["scaffold", "openapi.yaml"], { cwd });

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("ROUTA_OPENAPI_OPTIONS_AUTOMATIC");
		expect(result.stderr).toContain("Remove the options operation");
		expect(existsSync(join(cwd, "src/routes/users/route.ts"))).toBe(false);
	});

	it("refuses to overwrite unmanaged route files during scaffold", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-unmanaged-conflict-"));
		createTypeScriptProject(cwd);
		mkdirSync(join(cwd, "src/routes/users"), { recursive: true });
		writeFileSync(join(cwd, "src/routes/users/route.ts"), "export default {};\n");
		writeSimpleUsersOpenApi(cwd);

		const result = run(["scaffold", "openapi.yaml"], { cwd });

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("ROUTA_SCAFFOLD_UNMANAGED_FILE");
		expect(result.stderr).toContain(
			"Routa can only overwrite files tracked in .routa/manifest.json",
		);
	});

	it("refuses to overwrite modified generated route files during regeneration", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-modified-conflict-"));
		createTypeScriptProject(cwd);
		writeSimpleUsersOpenApi(cwd);
		run(["scaffold", "openapi.yaml"], { cwd });
		writeFileSync(join(cwd, "src/routes/users/route.ts"), "export default {};\n");

		const result = run(["scaffold", "openapi.yaml", "--yes"], { cwd });

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("ROUTA_SCAFFOLD_MODIFIED_GENERATED_FILE");
		expect(result.stderr).toContain("changed since the last Routa manifest hash");
	});

	it("regenerates modified routes metadata without treating it as user code", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-routes-gen-rewrite-"));
		createTypeScriptProject(cwd);
		writeSimpleUsersOpenApi(cwd);
		run(["scaffold", "openapi.yaml"], { cwd });
		writeFileSync(join(cwd, ".routa/routes.gen.ts"), "export const routaRoutes = [];\n");
		writeUsersAndItemOpenApi(cwd);

		const preview = run(["scaffold", "openapi.yaml", "--preview"], { cwd });
		const result = run(["scaffold", "openapi.yaml", "--yes"], { cwd });

		expect(preview.code).toBe(0);
		expect(preview.stdout).toContain("~ update .routa/routes.gen.ts");
		expect(preview.stdout).toContain("framework metadata will be regenerated");
		expect(result.code).toBe(0);
		expect(readFileSync(join(cwd, ".routa/routes.gen.ts"), "utf8")).toContain('"/users/:id"');
	});

	it("explains when regeneration cannot prove ownership because the manifest is missing", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-missing-manifest-"));
		createTypeScriptProject(cwd);
		writeSimpleUsersOpenApi(cwd);
		run(["scaffold", "openapi.yaml"], { cwd });
		unlinkSync(join(cwd, ".routa/manifest.json"));

		const result = run(["scaffold", "openapi.yaml", "--yes"], { cwd });

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("ROUTA_SCAFFOLD_UNMANAGED_FILE");
		expect(result.stderr).toContain("restore .routa/manifest.json");
	});

	it("requires preview or confirmation before regenerating an existing project", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-regen-confirm-"));
		createTypeScriptProject(cwd);
		writeSimpleUsersOpenApi(cwd);
		run(["scaffold", "openapi.yaml"], { cwd });

		const result = run(["scaffold", "openapi.yaml"], { cwd });

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("Regeneration requires preview or confirmation");
	});

	it("previews regeneration without writing new files", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-regen-preview-"));
		createTypeScriptProject(cwd);
		writeSimpleUsersOpenApi(cwd);
		run(["scaffold", "openapi.yaml"], { cwd });
		writeUsersAndItemOpenApi(cwd);

		const result = run(["scaffold", "openapi.yaml", "--preview"], { cwd });

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("Previewed");
		expect(result.stdout).toContain("Preview diff:");
		expect(result.stdout).toContain("+ add src/routes/users/$id/route.ts");
		expect(result.stdout).toContain("~ update .routa/manifest.json");
		expect(result.stdout).toContain("@@ line");
		expect(result.stdout).toContain("- ");
		expect(result.stdout).toContain("+ ");
		expect(() => readFileSync(join(cwd, "src/routes/users/$id/route.ts"), "utf8")).toThrow();
		expect(existsSync(join(cwd, "src/routes/users/$id"))).toBe(false);
	});

	it("previews regeneration conflicts without overwriting modified generated files", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-regen-preview-conflict-"));
		createTypeScriptProject(cwd);
		writeSimpleUsersOpenApi(cwd);
		run(["scaffold", "openapi.yaml"], { cwd });
		writeFileSync(join(cwd, "src/routes/users/route.ts"), "export default {};\n");

		const result = run(["scaffold", "openapi.yaml", "--preview"], { cwd });

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("! conflict src/routes/users/route.ts");
		expect(readFileSync(join(cwd, "src/routes/users/route.ts"), "utf8")).toBe(
			"export default {};\n",
		);
	});

	it("regenerates safely when adding a new OpenAPI route", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-regen-add-route-"));
		createTypeScriptProject(cwd);
		writeSimpleUsersOpenApi(cwd);
		run(["scaffold", "openapi.yaml"], { cwd });
		writeUsersAndItemOpenApi(cwd);

		const result = run(["scaffold", "openapi.yaml", "--yes"], { cwd });

		expect(result.code).toBe(0);
		expect(readFileSync(join(cwd, "src/routes/users/$id/route.ts"), "utf8")).toContain(
			"get: createRoute",
		);
		expect(readFileSync(join(cwd, ".routa/manifest.json"), "utf8")).toContain(
			"src/routes/users/$id/route.ts",
		);
		expect(readFileSync(join(cwd, ".routa/manifest.json"), "utf8")).toContain(
			".routa/routes.gen.ts",
		);
	});

	it("removes stale managed route files during regeneration", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-regen-remove-route-"));
		createTypeScriptProject(cwd);
		writeUsersAndItemOpenApi(cwd);
		run(["scaffold", "openapi.yaml"], { cwd });
		writeSimpleUsersOpenApi(cwd);

		const preview = run(["scaffold", "openapi.yaml", "--preview"], { cwd });
		const result = run(["scaffold", "openapi.yaml", "--yes"], { cwd });

		expect(preview.code).toBe(0);
		expect(preview.stdout).toContain("- remove src/routes/users/$id/route.ts");
		expect(result.code).toBe(0);
		expect(existsSync(join(cwd, "src/routes/users/$id/route.ts"))).toBe(false);
		expect(existsSync(join(cwd, "src/routes/users/$id/schemas.ts"))).toBe(false);
		expect(readFileSync(join(cwd, ".routa/manifest.json"), "utf8")).not.toContain(
			"src/routes/users/$id/route.ts",
		);
	});

	it("preserves user-owned business logic files during regeneration", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-user-owned-"));
		createTypeScriptProject(cwd);
		writeSimpleUsersOpenApi(cwd);
		run(["scaffold", "openapi.yaml"], { cwd });
		mkdirSync(join(cwd, "services"), { recursive: true });
		writeFileSync(join(cwd, "services/users.ts"), "export const owner = 'app';\n");
		writeUsersAndItemOpenApi(cwd);

		const result = run(["scaffold", "openapi.yaml", "--yes"], { cwd });

		expect(result.code).toBe(0);
		expect(readFileSync(join(cwd, "services/users.ts"), "utf8")).toBe(
			"export const owner = 'app';\n",
		);
		expect(readFileSync(join(cwd, ".routa/manifest.json"), "utf8")).not.toContain(
			"services/users.ts",
		);
	});

	it("passes openapi check when source matches scaffold baseline", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-openapi-clean-"));
		createTypeScriptProject(cwd);
		writeSimpleUsersOpenApi(cwd);
		run(["scaffold", "openapi.yaml"], { cwd });

		const result = run(["openapi", "check"], { cwd });

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("No drift detected");
	});

	it("reports openapi drift when a route response status changes", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-openapi-drift-"));
		createTypeScriptProject(cwd);
		writeSimpleUsersOpenApi(cwd);
		run(["scaffold", "openapi.yaml"], { cwd });
		const routeFile = join(cwd, "src/routes/users/route.ts");
		writeFileSync(routeFile, readFileSync(routeFile, "utf8").replace("status: 200", "status: 201"));

		const result = run(["openapi", "check"], { cwd });

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("OPENAPI_DRIFT");
		expect(result.stderr).toContain("GET /users response 201");
	});

	it("reports openapi drift when a route method is removed", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-openapi-method-drift-"));
		createTypeScriptProject(cwd);
		writeSimpleUsersOpenApi(cwd);
		run(["scaffold", "openapi.yaml"], { cwd });
		writeFileSync(
			join(cwd, "src/routes/users/route.ts"),
			`import { createRoute, createRouteRoot } from "@routa-ts/core";
import type { z } from "zod";
import { ListUsersResponse } from "./schemas.js";

export default createRouteRoot("/users")({
\tget: createRoute({
\t\tresponses: {
\t\t\tsuccess: {
\t\t\t\tstatus: 200,
\t\t\t\tschema: ListUsersResponse,
\t\t\t},
\t\t},
\t\trun: async () => ({ type: "success", data: [] as z.output<typeof ListUsersResponse> }),
\t}),
});
`,
		);

		const result = run(["openapi", "check"], { cwd });

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("OPENAPI_DRIFT");
		expect(result.stderr).toContain("POST /users removed");
	});

	it("reports openapi drift when a route method is added", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-openapi-method-added-"));
		createTypeScriptProject(cwd);
		writeSimpleUsersOpenApi(cwd);
		run(["scaffold", "openapi.yaml"], { cwd });
		writeFileSync(
			join(cwd, "src/routes/users/route.ts"),
			`import { createRoute, createRouteRoot } from "@routa-ts/core";
import { z } from "zod";
import { CreateUserBody, CreateUserResponse, ListUsersResponse } from "./schemas.js";

export default createRouteRoot("/users")({
\tget: createRoute({
\t\tresponses: {
\t\t\tsuccess: {
\t\t\t\tstatus: 200,
\t\t\t\tschema: ListUsersResponse,
\t\t\t},
\t\t},
\t\trun: async () => ({ type: "success", data: [] as z.output<typeof ListUsersResponse> }),
\t}),
\tpost: createRoute({
\t\tinput: {
\t\t\tbody: CreateUserBody,
\t\t},
\t\tresponses: {
\t\t\tsuccess: {
\t\t\t\tstatus: 201,
\t\t\t\tschema: CreateUserResponse,
\t\t\t},
\t\t},
\t\trun: async ({ input }) => ({
\t\t\ttype: "success",
\t\t\tdata: { id: "usr_1", name: input.body.name } as z.output<typeof CreateUserResponse>,
\t\t}),
\t}),
\tdelete: createRoute({
\t\tresponses: {
\t\t\tsuccess: {
\t\t\t\tstatus: 204,
\t\t\t\tschema: z.unknown(),
\t\t\t},
\t\t},
\t\trun: async () => ({ type: "success", data: null }),
\t}),
});
`,
		);

		const result = run(["openapi", "check"], { cwd });

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("OPENAPI_DRIFT");
		expect(result.stderr).toContain("DELETE /users added");
	});

	it("fails openapi check when the route graph has diagnostics", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-openapi-invalid-graph-"));
		createTypeScriptProject(cwd);
		writeSimpleUsersOpenApi(cwd);
		run(["scaffold", "openapi.yaml"], { cwd });
		writeFileSync(
			join(cwd, "src/routes/users/route.ts"),
			`import { createRoute, createRouteRoot } from "@routa-ts/core";

export default createRouteRoot("/users")({
\tget: createRoute({
\t\tresponses: {},
\t\trun: async () => ({ type: "success", data: null }),
\t}),
});
`,
		);

		const result = run(["openapi", "check"], { cwd });

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("ROUTA_MISSING_SUCCESS_RESPONSE");
	});

	it("generates OpenAPI params, request bodies, and JSON response content from routes", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-openapi-shape-"));
		createTypeScriptProject(cwd);
		mkdirSync(join(cwd, "src/routes/users/$id"), { recursive: true });
		writeFileSync(
			join(cwd, "src/routes/users/$id/route.ts"),
			`import { createRoute, createRouteRoot } from "@routa-ts/core";
import { z } from "zod";

export default createRouteRoot("/users/:id")({
\tpatch: createRoute({
\t\tinput: {
\t\t\tparams: z.object({ id: z.string() }),
\t\t\tbody: z.object({ name: z.string() }),
\t\t},
\t\tresponses: {
\t\t\tsuccess: {
\t\t\t\tstatus: 200,
\t\t\t\tschema: z.object({ id: z.string() }),
\t\t\t},
\t\t},
\t\trun: async () => ({ type: "success", data: { id: "user_1" } }),
\t}),
});
`,
		);

		const openapi = generateOpenApi(cwd);
		const operation = openapi.paths?.["/users/{id}"]?.patch;

		expect(operation?.parameters).toEqual([
			{
				name: "id",
				in: "path",
				required: true,
				schema: { type: "string" },
			},
		]);
		expect(operation?.requestBody).toEqual({
			required: true,
			content: {
				"application/json": {
					schema: {
						type: "object",
						required: ["name"],
						properties: {
							name: { type: "string" },
						},
					},
				},
			},
		});
		expect(operation?.responses?.["200"]).toEqual({
			description: "Generated by Routa",
			content: {
				"application/json": {
					schema: {
						type: "object",
						required: ["id"],
						properties: {
							id: { type: "string" },
						},
					},
				},
			},
		});
	});

	it("omits JSON response content for bodyless responses", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-openapi-bodyless-"));
		createTypeScriptProject(cwd);
		mkdirSync(join(cwd, "src/routes/users/$id"), { recursive: true });
		writeFileSync(
			join(cwd, "src/routes/users/$id/route.ts"),
			`import { createRoute, createRouteRoot } from "@routa-ts/core";
import { z } from "zod";

export default createRouteRoot("/users/:id")({
\tdelete: createRoute({
\t\tresponses: {
\t\t\tsuccess: {
\t\t\t\tstatus: 204,
\t\t\t\tschema: z.unknown(),
\t\t\t},
\t\t\treset: {
\t\t\t\tstatus: 205,
\t\t\t\tschema: z.unknown(),
\t\t\t},
\t\t\tnotModified: {
\t\t\t\tstatus: 304,
\t\t\t\tschema: z.unknown(),
\t\t\t},
\t\t},
\t\trun: async () => ({ type: "success", data: undefined }),
\t}),
});
`,
		);

		const openapi = generateOpenApi(cwd);

		expect(openapi.paths?.["/users/{id}"]?.delete?.responses?.["204"]).toEqual({
			description: "Generated by Routa",
		});
		expect(openapi.paths?.["/users/{id}"]?.delete?.responses?.["205"]).toEqual({
			description: "Generated by Routa",
		});
		expect(openapi.paths?.["/users/{id}"]?.delete?.responses?.["304"]).toEqual({
			description: "Generated by Routa",
		});
	});

	it("preserves operationIds from the OpenAPI baseline during source generation", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-openapi-operation-id-"));
		createTypeScriptProject(cwd);
		writeSimpleUsersOpenApi(cwd);
		run(["scaffold", "openapi.yaml"], { cwd });

		const openapi = generateOpenApi(cwd);

		expect(openapi.paths?.["/users"]?.get?.operationId).toBe("listUsers");
		expect(openapi.paths?.["/users"]?.post?.operationId).toBe("createUser");
	});

	it("reports removed methods in openapi breaking checks", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-openapi-breaking-"));
		createTypeScriptProject(cwd);
		writeSimpleUsersOpenApi(cwd);
		run(["scaffold", "openapi.yaml"], { cwd });
		writeFileSync(
			join(cwd, "src/routes/users/route.ts"),
			`import { createRoute, createRouteRoot } from "@routa-ts/core";
import { ListUsersResponse } from "./schemas.js";

export default createRouteRoot("/users")({
\tget: createRoute({
\t\tresponses: {
\t\t\tsuccess: {
\t\t\t\tstatus: 200,
\t\t\t\tschema: ListUsersResponse,
\t\t\t},
\t\t},
\t\trun: async () => ({ type: "success", data: [] }),
\t}),
});
`,
		);

		const result = run(["openapi", "breaking"], { cwd });

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("OPENAPI_REMOVED_OPERATION");
		expect(result.stderr).toContain("POST /users");
		expect(result.stderr).toContain("--update-baseline");
	});

	it("discovers flat collection and dynamic route files", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-flat-routes-"));
		createTypeScriptProject(cwd);
		mkdirSync(join(cwd, "src/routes"), { recursive: true });
		writeFileSync(
			join(cwd, "src/routes/users.ts"),
			`import { createRoute, createRouteRoot } from "@routa-ts/core";
export default createRouteRoot("/users")({ get: createRoute({ responses: {}, run: () => ({ type: "success", data: null }) }) });
`,
		);
		writeFileSync(
			join(cwd, "src/routes/tasks.$id.ts"),
			`import { createRoute, createRouteRoot } from "@routa-ts/core";
export default createRouteRoot("/tasks/:id")({ get: createRoute({ responses: {}, run: () => ({ type: "success", data: null }) }) });
`,
		);

		const result = validateProject(cwd, { write: false });

		expect(result.routes.map((route) => route.path).sort()).toEqual(["/tasks/:id", "/users"]);
	});

	it("reports query parameters that become required in openapi breaking checks", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-openapi-required-input-"));
		createTypeScriptProject(cwd);
		writeFileSync(
			join(cwd, "openapi.yaml"),
			`openapi: 3.1.0
info:
  title: Users API
  version: 1.0.0
paths:
  /users:
    get:
      operationId: listUsers
      parameters:
        - name: status
          in: query
          required: false
          schema:
            type: string
      responses:
        "200":
          description: OK
          content:
            application/json:
              schema:
                type: array
                items:
                  type: string
`,
		);
		run(["scaffold", "openapi.yaml"], { cwd });
		const schemas = join(cwd, "src/routes/users/schemas.ts");
		writeFileSync(
			schemas,
			readFileSync(schemas, "utf8").replace("z.string().optional()", "z.string()"),
		);

		const result = run(["openapi", "breaking"], { cwd });

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("OPENAPI_REQUIRED_INPUT");
		expect(result.stderr).toContain('GET /users query parameter "status" became required');
	});

	it("reports newly declared middleware security as a breaking change", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-openapi-auth-breaking-"));
		createTypeScriptProject(cwd);
		writeSimpleUsersOpenApi(cwd);
		run(["scaffold", "openapi.yaml"], { cwd });
		const route = join(cwd, "src/routes/users/route.ts");
		writeFileSync(
			route,
			readFileSync(route, "utf8")
				.replace(
					'import { createRoute, createRouteRoot } from "@routa-ts/core";',
					'import { createMiddleware, createRoute, createRouteRoot } from "@routa-ts/core";\n\nconst requireAuth = createMiddleware({ openapi: { security: [{ bearerAuth: [] }], permissions: ["users.read"] } });',
				)
				.replace("get: createRoute({", "get: createRoute({\n\t\tmiddleware: [requireAuth],"),
		);

		const result = run(["openapi", "breaking"], { cwd });

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("OPENAPI_TIGHTER_AUTH: GET /users now requires authentication");
	});

	it("emits route deprecation metadata into OpenAPI", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-openapi-deprecation-"));
		createTypeScriptProject(cwd);
		writeSimpleUsersOpenApi(cwd);
		run(["scaffold", "openapi.yaml"], { cwd });
		const route = join(cwd, "src/routes/users/route.ts");
		writeFileSync(
			route,
			readFileSync(route, "utf8").replace(
				"get: createRoute({",
				'get: createRoute({\n\t\tdeprecation: { sunset: "2027-01-01", replacement: "https://v2.example.com/users" },',
			),
		);

		const operation = generateOpenApi(cwd).paths?.["/users"]?.get;

		expect(operation?.deprecated).toBe(true);
		expect(operation?.["x-routa-sunset"]).toBe("2027-01-01");
	});

	it("validates local and external deprecation replacements", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-deprecation-replacements-"));
		createTypeScriptProject(cwd);
		mkdirSync(join(cwd, "src/routes"), { recursive: true });
		writeFileSync(
			join(cwd, "src/routes/status.ts"),
			`import { createRoute, createRouteRoot } from "@routa-ts/core";
export default createRouteRoot("/status")({ get: createRoute({ responses: {}, run: () => ({ type: "success", data: null }) }) });
`,
		);
		writeFileSync(
			join(cwd, "src/routes/legacy.ts"),
			`import { createRoute, createRouteRoot } from "@routa-ts/core";
export default createRouteRoot("/legacy")({ get: createRoute({ deprecation: { replacement: "/missing" }, responses: {}, run: () => ({ type: "success", data: null }) }) });
`,
		);

		const missing = run(["check"], { cwd });
		expect(missing.code).toBe(1);
		expect(missing.stderr).toContain("ROUTA_DEPRECATION_REPLACEMENT_ROUTE_NOT_FOUND");

		writeFileSync(
			join(cwd, "src/routes/legacy.ts"),
			readFileSync(join(cwd, "src/routes/legacy.ts"), "utf8").replace('"/missing"', '"next-api"'),
		);
		const invalidUrl = run(["check"], { cwd });
		expect(invalidUrl.code).toBe(1);
		expect(invalidUrl.stderr).toContain("ROUTA_DEPRECATION_REPLACEMENT_URL_INVALID");

		writeFileSync(
			join(cwd, "src/routes/legacy.ts"),
			readFileSync(join(cwd, "src/routes/legacy.ts"), "utf8").replace('"next-api"', '"/status"'),
		);
		expect(
			validateProject(cwd, { write: false }).diagnostics.some((diagnostic) =>
				diagnostic.code.startsWith("ROUTA_DEPRECATION_"),
			),
		).toBe(false);
	});

	it("generates body route contracts that typecheck in a consumer project", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-consumer-typecheck-"));
		createTypeScriptProject(cwd);
		writeSimpleUsersOpenApi(cwd);
		run(["scaffold", "openapi.yaml"], { cwd });
		writeFileSync(
			join(cwd, "tsconfig.json"),
			JSON.stringify(
				{
					compilerOptions: {
						target: "ES2022",
						module: "NodeNext",
						moduleResolution: "NodeNext",
						strict: true,
						skipLibCheck: true,
						paths: {
							"@routa-ts/core": [join(repoRoot, "packages/core/src/index.ts")],
							zod: [join(repoRoot, "packages/core/node_modules/zod/index.d.ts")],
						},
					},
					include: ["src/routes/**/*.ts"],
				},
				null,
				"\t",
			),
		);

		const result = spawnSync(
			"pnpm",
			["exec", "tsc", "-p", join(cwd, "tsconfig.json"), "--noEmit"],
			{
				cwd: repoRoot,
				encoding: "utf8",
			},
		);

		expect(withoutPnpmWarnings(result.stderr)).toBe("");
		expect(result.stdout).toBe("");
		expect(result.status).toBe(0);
	});
});

function withoutPnpmWarnings(output: string): string {
	if (output.startsWith('[WARN] The "pnpm" field in package.json is no longer read by pnpm.')) {
		return "";
	}

	return output
		.split("\n")
		.filter((line) => line && !line.startsWith("[WARN]"))
		.join("\n");
}

function createTypeScriptProject(cwd: string): void {
	mkdirSync(join(cwd, "src"), { recursive: true });
	mkdirSync(join(cwd, "node_modules/@routa-ts"), { recursive: true });
	symlinkSync(join(repoRoot, "packages/core"), join(cwd, "node_modules/@routa-ts/core"), "dir");
	writeFileSync(
		join(cwd, "package.json"),
		JSON.stringify(
			{
				type: "module",
				dependencies: {
					"@routa-ts/cli": "workspace:*",
					"@routa-ts/core": "workspace:*",
					zod: "^4.4.3",
				},
				devDependencies: {
					typescript: "7.0.2",
				},
			},
			null,
			"\t",
		),
	);
	writeFileSync(
		join(cwd, "tsconfig.json"),
		JSON.stringify(
			{
				compilerOptions: {
					target: "ES2022",
					module: "NodeNext",
					moduleResolution: "NodeNext",
					strict: true,
					skipLibCheck: true,
					paths: {
						"@routa-ts/core": [join(repoRoot, "packages/core/src/index.ts")],
						"@routa-ts/core/hono": [join(repoRoot, "packages/core/src/hono.ts")],
						zod: [join(repoRoot, "packages/core/node_modules/zod/index.d.ts")],
					},
				},
				include: ["src/**/*.ts", ".routa/**/*.ts"],
			},
			null,
			"\t",
		),
	);
	writeFileSync(
		join(cwd, "src/routa.ts"),
		`import { createRouta } from "@routa-ts/core";

export default createRouta({
\tport: 3000,
});
`,
	);
}

function writeCompiledRuntimeFiles(cwd: string, sourceFiles: readonly string[]): void {
	for (const sourceFile of sourceFiles) {
		const outputFile = join(cwd, "dist", sourceFile.replace(/\.ts$/, ".js"));
		mkdirSync(dirname(outputFile), { recursive: true });
		writeFileSync(outputFile, "export default {};\n");
	}
}

function writeSimpleUsersOpenApi(cwd: string): void {
	writeFileSync(join(cwd, "openapi.yaml"), simpleUsersOpenApi());
}

function writeUsersAndItemOpenApi(cwd: string): void {
	writeFileSync(
		join(cwd, "openapi.yaml"),
		`${simpleUsersOpenApi()}
  /users/{id}:
    get:
      operationId: getUserById
      parameters:
        - name: id
          in: path
          required: true
          schema:
            type: string
      responses:
        "200":
          description: User
          content:
            application/json:
              schema:
                type: object
`,
	);
}

function writeOpenApiPaths(cwd: string, paths: string): void {
	writeFileSync(
		join(cwd, "openapi.yaml"),
		`openapi: 3.1.0
info:
  title: Users API
  version: 0.0.0
paths:
${paths}`,
	);
}

function simpleUsersOpenApi(): string {
	return `openapi: 3.1.0
info:
  title: Users API
  version: 0.0.0
paths:
  /users:
    get:
      operationId: listUsers
      responses:
        "200":
          description: Users
          content:
            application/json:
              schema:
                type: array
                items:
                  type: object
    post:
      operationId: createUser
      responses:
        "201":
          description: Created
          content:
            application/json:
              schema:
                type: object
`;
}

async function waitForMtimeTick(): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, 20));
}
