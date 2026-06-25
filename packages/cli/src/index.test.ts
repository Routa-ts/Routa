import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { run } from "./index.js";
import { generateOpenApi } from "./openapi.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("routa cli", () => {
	it("prints help by default", () => {
		const result = run([]);

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("routa create [dir]");
	});

	it("requires an OpenAPI file for scaffold", () => {
		const result = run(["scaffold"]);

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("Missing OpenAPI input file");
	});

	it("checks a route graph and writes routes metadata", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-check-"));
		mkdirSync(join(cwd, "routes/(private)/users"), { recursive: true });
		writeFileSync(
			join(cwd, "routes/middleware.ts"),
			`import { createMiddleware } from "@routa/core";

export const withDb = createMiddleware({
\tprovides: ["db"],
});
`,
		);
		writeFileSync(
			join(cwd, "routes/(private)/middleware.ts"),
			`import { createMiddleware } from "@routa/core";

export const requireAuth = createMiddleware({
\trequires: ["db"],
\tprovides: ["user"],
});
`,
		);
		writeFileSync(join(cwd, "routes/(private)/users/route.ts"), "export default {};\n");

		const result = run(["check"], { cwd });

		expect(result.code).toBe(0);
		expect(readFileSync(join(cwd, ".routa/routes.gen.ts"), "utf8")).toContain('"/users"');
		expect(readFileSync(join(cwd, ".routa/routes.gen.ts"), "utf8")).toContain(
			"routes/(private)/middleware.ts",
		);
		expect(readFileSync(join(cwd, ".routa/routes.gen.ts"), "utf8")).toContain('"provides"');
		expect(readFileSync(join(cwd, ".routa/routes.gen.ts"), "utf8")).toContain('"ctx"');
		expect(readFileSync(join(cwd, ".routa/routes.gen.ts"), "utf8")).toContain('"db"');
		expect(readFileSync(join(cwd, ".routa/routes.gen.ts"), "utf8")).toContain('"user"');
		expect(readFileSync(join(cwd, ".routa/routes.gen.ts"), "utf8")).toContain(
			"export type UsersCtx",
		);
	});

	it("reports middleware order diagnostics when requirements are missing", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-middleware-order-"));
		mkdirSync(join(cwd, "routes/(private)/users"), { recursive: true });
		writeFileSync(
			join(cwd, "routes/(private)/middleware.ts"),
			`import { createMiddleware } from "@routa/core";

export const requireAuth = createMiddleware({
\trequires: ["db"],
\tprovides: ["user"],
});
`,
		);
		writeFileSync(
			join(cwd, "routes/(private)/users/route.ts"),
			`import { createRoute, defineRoute } from "@routa/core";

const requirePermission = createMiddleware({
\trequires: ["user"],
});

export default defineRoute({
\tmiddleware: [requirePermission],
});
`,
		);

		const result = run(["check"], { cwd });

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("ROUTA_MIDDLEWARE_ORDER");
		expect(result.stderr).toContain("requires ctx.db");
	});

	it("applies route-file middleware before method middleware", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-route-method-middleware-"));
		mkdirSync(join(cwd, "routes/users/$id"), { recursive: true });
		writeFileSync(
			join(cwd, "routes/users/$id/route.ts"),
			`import { createMiddleware, createRoute, defineRoute } from "@routa/core";

const loadUserResource = createMiddleware({
\tprovides: ["userResource"],
});

const requirePermission = createMiddleware({
\trequires: ["userResource"],
\tprovides: ["permission"],
});

export default defineRoute({
\tmiddleware: [loadUserResource],
\tpatch: createRoute({
\t\tmiddleware: [requirePermission],
\t\tresponses: {
\t\t\tsuccess: {
\t\t\t\tstatus: 200,
\t\t\t\tschema: {},
\t\t\t},
\t\t},
\t\trun: async () => ({ type: "success", data: null }),
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

	it("parses middleware contracts with nested input schemas", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-middleware-input-"));
		mkdirSync(join(cwd, "routes/users"), { recursive: true });
		writeFileSync(
			join(cwd, "routes/middleware.ts"),
			`import { createMiddleware } from "@routa/core";
import { z } from "zod";

export const withTenant = createMiddleware({
\tinput: {
\t\theaders: z.object({
\t\t\t"x-tenant-id": z.string(),
\t\t}),
\t},
\tprovides: ["tenant"],
});
`,
		);
		writeFileSync(
			join(cwd, "routes/users/route.ts"),
			`import { createMiddleware, defineRoute } from "@routa/core";

const requireTenant = createMiddleware({
\trequires: ["tenant"],
});

export default defineRoute({
\tmiddleware: [requireTenant],
});
`,
		);

		const result = run(["check"], { cwd });

		expect(result.code).toBe(0);
		expect(readFileSync(join(cwd, ".routa/routes.gen.ts"), "utf8")).toContain('"tenant"');
	});

	it("reports duplicate route paths before typechecking", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-duplicate-routes-"));
		mkdirSync(join(cwd, "routes/users"), { recursive: true });
		mkdirSync(join(cwd, "routes/(admin)/users"), { recursive: true });
		writeFileSync(join(cwd, "routes/users/route.ts"), "export default {};\n");
		writeFileSync(join(cwd, "routes/(admin)/users/route.ts"), "export default {};\n");

		const result = run(["build"], { cwd });

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("ROUTA_DUPLICATE_ROUTE");
		expect(result.stderr).toContain("/users");
	});

	it("reports missing success responses before typechecking", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-missing-success-"));
		mkdirSync(join(cwd, "routes/users"), { recursive: true });
		writeFileSync(
			join(cwd, "routes/users/route.ts"),
			`import { createRoute, defineRoute } from "@routa/core";

export default defineRoute({
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

	it("reports duplicate schema exports with Routa diagnostics", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-duplicate-schema-"));
		mkdirSync(join(cwd, "routes/users"), { recursive: true });
		writeFileSync(join(cwd, "routes/users/route.ts"), "export default {};\n");
		writeFileSync(
			join(cwd, "routes/users/schemas.ts"),
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
		expect(readFileSync(join(cwd, "routes/users/route.ts"), "utf8")).toContain("get: createRoute");
		expect(readFileSync(join(cwd, "routes/users/route.ts"), "utf8")).toContain("post: createRoute");
		expect(readFileSync(join(cwd, "routes/users/route.ts"), "utf8")).toContain(
			'data: { "id": "" }',
		);
		expect(readFileSync(join(cwd, "routes/users/schemas.ts"), "utf8")).toContain(
			"export const CreateUserBody",
		);
		expect(readFileSync(join(cwd, ".routa/manifest.json"), "utf8")).toContain("listUsers");
		expect(readFileSync(join(cwd, ".routa/routes.gen.ts"), "utf8")).toContain('"/users"');
	});

	it("scaffolds item params from OpenAPI JSON", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-scaffold-json-"));
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
		expect(readFileSync(join(cwd, "routes/users/$id/route.ts"), "utf8")).toContain(
			"params: GetUserByIdParams",
		);
		expect(readFileSync(join(cwd, "routes/users/$id/schemas.ts"), "utf8")).toContain(
			'"id": z.string()',
		);
	});

	it("preserves component ref schema identity", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-component-ref-"));
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
		const schemas = readFileSync(join(cwd, "routes/users/$id/schemas.ts"), "utf8");
		expect(schemas).toContain("export const User = z.object");
		expect(schemas).toContain("export const GetUserResponse = User");
	});

	it("rejects unsupported scaffold input before writing files", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-scaffold-txt-"));
		writeFileSync(join(cwd, "openapi.txt"), "not supported");

		const result = run(["scaffold", "openapi.txt"], { cwd });

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("Unsupported OpenAPI input");
	});

	it("rejects OpenAPI operations without operationId", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-missing-operation-id-"));
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
		expect(result.stderr).toContain("Missing operationId");
	});

	it("rejects duplicate operationIds", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-duplicate-operation-id-"));
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
		expect(result.stderr).toContain("Duplicate operationId");
	});

	it("rejects generated names that are not valid TypeScript identifiers", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-invalid-identifier-"));
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
		expect(result.stderr).toContain("Invalid generated TypeScript identifier");
		expect(result.stderr).toContain("123BadName");
	});

	it("rejects unsupported OpenAPI media types before writing files", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-unsupported-media-type-"));
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

	it("refuses to overwrite unmanaged route files during scaffold", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-unmanaged-conflict-"));
		mkdirSync(join(cwd, "routes/users"), { recursive: true });
		writeFileSync(join(cwd, "routes/users/route.ts"), "export default {};\n");
		writeSimpleUsersOpenApi(cwd);

		const result = run(["scaffold", "openapi.yaml"], { cwd });

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("Refusing to overwrite unmanaged file");
	});

	it("refuses to overwrite modified generated route files during regeneration", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-modified-conflict-"));
		writeSimpleUsersOpenApi(cwd);
		run(["scaffold", "openapi.yaml"], { cwd });
		writeFileSync(join(cwd, "routes/users/route.ts"), "export default {};\n");

		const result = run(["scaffold", "openapi.yaml", "--yes"], { cwd });

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("Refusing to overwrite modified generated file");
	});

	it("requires preview or confirmation before regenerating an existing project", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-regen-confirm-"));
		writeSimpleUsersOpenApi(cwd);
		run(["scaffold", "openapi.yaml"], { cwd });

		const result = run(["scaffold", "openapi.yaml"], { cwd });

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("Regeneration requires preview or confirmation");
	});

	it("previews regeneration without writing new files", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-regen-preview-"));
		writeSimpleUsersOpenApi(cwd);
		run(["scaffold", "openapi.yaml"], { cwd });
		writeUsersAndItemOpenApi(cwd);

		const result = run(["scaffold", "openapi.yaml", "--preview"], { cwd });

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("Previewed");
		expect(() => readFileSync(join(cwd, "routes/users/$id/route.ts"), "utf8")).toThrow();
	});

	it("regenerates safely when adding a new OpenAPI route", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-regen-add-route-"));
		writeSimpleUsersOpenApi(cwd);
		run(["scaffold", "openapi.yaml"], { cwd });
		writeUsersAndItemOpenApi(cwd);

		const result = run(["scaffold", "openapi.yaml", "--yes"], { cwd });

		expect(result.code).toBe(0);
		expect(readFileSync(join(cwd, "routes/users/$id/route.ts"), "utf8")).toContain(
			"get: createRoute",
		);
		expect(readFileSync(join(cwd, ".routa/manifest.json"), "utf8")).toContain(
			"routes/users/$id/route.ts",
		);
	});

	it("preserves user-owned business logic files during regeneration", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-user-owned-"));
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
		writeSimpleUsersOpenApi(cwd);
		run(["scaffold", "openapi.yaml"], { cwd });

		const result = run(["openapi", "check"], { cwd });

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("No drift detected");
	});

	it("reports openapi drift when a route response status changes", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-openapi-drift-"));
		writeSimpleUsersOpenApi(cwd);
		run(["scaffold", "openapi.yaml"], { cwd });
		const routeFile = join(cwd, "routes/users/route.ts");
		writeFileSync(routeFile, readFileSync(routeFile, "utf8").replace("status: 200", "status: 201"));

		const result = run(["openapi", "check"], { cwd });

		expect(result.code).toBe(1);
		expect(result.stderr).toContain("OPENAPI_DRIFT");
		expect(result.stderr).toContain("GET /users response 201");
	});

	it("reports openapi drift when a route method is removed", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-openapi-method-drift-"));
		writeSimpleUsersOpenApi(cwd);
		run(["scaffold", "openapi.yaml"], { cwd });
		writeFileSync(
			join(cwd, "routes/users/route.ts"),
			`import { createRoute, defineRoute } from "@routa/core";
import type { z } from "zod";
import { ListUsersResponse } from "./schemas.js";

export default defineRoute({
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

	it("generates OpenAPI params, request bodies, and JSON response content from routes", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-openapi-shape-"));
		mkdirSync(join(cwd, "routes/users/$id"), { recursive: true });
		writeFileSync(
			join(cwd, "routes/users/$id/route.ts"),
			`import { createRoute, defineRoute } from "@routa/core";
import { z } from "zod";

export default defineRoute({
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
			content: {
				"application/json": {
					schema: { type: "object" },
				},
			},
		});
		expect(operation?.responses?.["200"]).toEqual({
			description: "Generated by Routa",
			content: {
				"application/json": {
					schema: { type: "object" },
				},
			},
		});
	});

	it("reports removed methods in openapi breaking checks", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-openapi-breaking-"));
		writeSimpleUsersOpenApi(cwd);
		run(["scaffold", "openapi.yaml"], { cwd });
		writeFileSync(
			join(cwd, "routes/users/route.ts"),
			`import { createRoute, defineRoute } from "@routa/core";
import { ListUsersResponse } from "./schemas.js";

export default defineRoute({
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

		expect(result.code).toBe(0);
		expect(result.stdout).toContain("OPENAPI_REMOVED_OPERATION");
		expect(result.stdout).toContain("POST /users");
	});

	it("generates body route contracts that typecheck in a consumer project", () => {
		const cwd = mkdtempSync(join(tmpdir(), "routa-consumer-typecheck-"));
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
						baseUrl: ".",
						paths: {
							"@routa/core": [join(repoRoot, "packages/core/src/index.ts")],
							zod: [join(repoRoot, "packages/core/node_modules/zod/index.d.ts")],
						},
					},
					include: ["routes/**/*.ts"],
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

		expect(result.stderr).toBe("");
		expect(result.stdout).toBe("");
		expect(result.status).toBe(0);
	});
});

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
