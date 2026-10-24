import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { run } from "./index.js";
import { generateOpenApi } from "./openapi.js";
import { validateProject } from "./project.js";

type Json = Record<string, unknown>;

const userSchemas = `import { z } from "zod";

export const User = z.object({ id: z.string(), name: z.string() });
export const Problem = z.object({ message: z.string() });
`;

/**
 * A route with auth middleware, a 404 outcome, and a component schema.
 */
function userRoute(options: { security?: boolean; notFound?: boolean } = {}): string {
	const { security = true, notFound = true } = options;
	return `import { createMiddleware, createRoute, createRouteRoot } from "@routa-ts/core";
import { Problem, User } from "./schemas.js";

const requireSession = createMiddleware({ openapi: { security: [{ sessionCookie: [] }] } });

export default createRouteRoot("/users/:id")({
\tget: createRoute({
${security ? "\t\tmiddleware: [requireSession],\n" : ""}\t\tresponses: {
\t\t\tok: { status: 200, schema: User },
${notFound ? "\t\t\tnotFound: { status: 404, schema: Problem },\n" : ""}\t\t},
\t\trun: async () => ({ type: "ok", data: { id: "1", name: "Ada" } }),
\t}),
});
`;
}

describe("OpenAPI generated from source", () => {
	it("generates the document from source alone, with generated operationIds and default info", () => {
		const cwd = project({
			"src/routes/users/$id/schemas.ts": userSchemas,
			"src/routes/users/$id/route.ts": userRoute(),
		});

		const document = generateOpenApi(cwd) as Json;

		expect(document.info).toEqual({ title: "Routa API", version: "0.0.0" });
		expect(document).not.toHaveProperty("servers");
		expect(operation(document, "/users/{id}", "get")).toMatchObject({
			operationId: "getUsersId",
			security: [{ sessionCookie: [] }],
		});
		expect(Object.keys(operation(document, "/users/{id}", "get").responses as Json)).toEqual([
			"200",
			"404",
		]);
	});

	it("does not change the current document when only the baseline changes", () => {
		const cwd = project({
			"src/routes/users/$id/schemas.ts": userSchemas,
			"src/routes/users/$id/route.ts": userRoute(),
		});
		const withoutBaseline = generateOpenApi(cwd);

		writeBaseline(cwd, {
			openapi: "3.1.0",
			info: { title: "Hand written", version: "9.9.9" },
			servers: [{ url: "https://api.example.com" }],
			paths: {
				"/users/{id}": {
					get: {
						operationId: "fetchUser",
						security: [{ oldAuth: [] }],
						responses: {
							"200": { description: "OK" },
							"410": { description: "Gone", content: { "application/json": { schema: {} } } },
						},
					},
					delete: { operationId: "removeUser", responses: { "204": { description: "Gone" } } },
				},
				"/legacy": { get: { operationId: "legacy", responses: { "200": { description: "OK" } } } },
			},
			components: { schemas: { Legacy: { type: "string" }, User: { type: "integer" } } },
		});

		expect(generateOpenApi(cwd)).toEqual(withoutBaseline);

		writeBaseline(cwd, { openapi: "3.1.0", info: { title: "Other", version: "1" }, paths: {} });

		expect(generateOpenApi(cwd)).toEqual(withoutBaseline);
	});

	it("reports an operationId shared by two routes instead of picking one", () => {
		const cwd = project({
			"src/routes/users/$id/schemas.ts": userSchemas,
			"src/routes/users/$id/route.ts": userRoute(),
			"src/routes/users/id/schemas.ts": userSchemas,
			"src/routes/users/id/route.ts": userRoute().replace("/users/:id", "/users/id"),
		});

		const { diagnostics } = validateProject(cwd, { write: false });

		expect(diagnostics.map((item) => [item.code, item.message])).toEqual([
			[
				"ROUTA_DUPLICATE_OPERATION_ID",
				"GET /users/id and GET /users/:id would both generate the OpenAPI operationId getUsersId.",
			],
		]);
	});

	describe("openapi check", () => {
		const acceptedBaseline = (cwd: string) => {
			writeBaseline(cwd, generateOpenApi(cwd));
		};

		it("passes while source and baseline agree, whatever the baseline calls its identity", async () => {
			const cwd = project({
				"src/routes/users/$id/schemas.ts": userSchemas,
				"src/routes/users/$id/route.ts": userRoute(),
			});
			const accepted = generateOpenApi(cwd) as Json;
			writeBaseline(cwd, {
				...accepted,
				info: { title: "Users API", version: "1.2.3" },
				servers: [{ url: "https://api.example.com" }],
				paths: {
					"/users/{id}": {
						get: { ...operation(accepted, "/users/{id}", "get"), operationId: "getUserById" },
					},
				},
			});

			const result = await run(["openapi", "check"], { cwd });

			expect(result).toMatchObject({ code: 0 });
			expect(result.stdout).toContain("No drift detected");
		});

		it("reports a response status removed from source", async () => {
			const cwd = project({
				"src/routes/users/$id/schemas.ts": userSchemas,
				"src/routes/users/$id/route.ts": userRoute(),
			});
			acceptedBaseline(cwd);
			writeFileSync(
				join(cwd, "src/routes/users/$id/route.ts"),
				userRoute({ notFound: false }),
			);

			const result = await run(["openapi", "check"], { cwd });

			expect(result.code).toBe(1);
			expect(result.stderr).toContain("OPENAPI_DRIFT: GET /users/{id} response 404 removed");
		});

		it("reports authentication removed from source", async () => {
			const cwd = project({
				"src/routes/users/$id/schemas.ts": userSchemas,
				"src/routes/users/$id/route.ts": userRoute(),
			});
			acceptedBaseline(cwd);
			writeFileSync(join(cwd, "src/routes/users/$id/route.ts"), userRoute({ security: false }));

			const check = await run(["openapi", "check"], { cwd });
			const breaking = await run(["openapi", "breaking"], { cwd });

			expect(check.code).toBe(1);
			expect(check.stderr).toContain("OPENAPI_DRIFT: GET /users/{id} security changed");
			expect(breaking).toMatchObject({ code: 0 });
			expect(operation(generateOpenApi(cwd) as Json, "/users/{id}", "get")).not.toHaveProperty(
				"security",
			);
		});

		it("reports a changed security scheme and ignores requirement order", async () => {
			const cwd = project({
				"src/routes/users/$id/schemas.ts": userSchemas,
				"src/routes/users/$id/route.ts": userRoute(),
			});
			const accepted = generateOpenApi(cwd) as Json;
			const baseline = (security: unknown) =>
				writeBaseline(cwd, {
					...accepted,
					paths: {
						"/users/{id}": {
							get: { ...operation(accepted, "/users/{id}", "get"), security },
						},
					},
				});

			baseline([{ sessionCookie: [] }]);
			expect((await run(["openapi", "check"], { cwd })).code).toBe(0);

			baseline([{ bearerAuth: [] }]);
			const check = await run(["openapi", "check"], { cwd });

			expect(check.code).toBe(1);
			expect(check.stderr).toContain("OPENAPI_DRIFT: GET /users/{id} security changed");
		});

		it("reports component content changed in source", async () => {
			const cwd = project({
				"src/routes/users/$id/schemas.ts": userSchemas,
				"src/routes/users/$id/route.ts": userRoute(),
			});
			acceptedBaseline(cwd);
			writeFileSync(
				join(cwd, "src/routes/users/$id/schemas.ts"),
				userSchemas.replace("id: z.string()", "id: z.number()"),
			);

			const result = await run(["openapi", "check"], { cwd });

			expect(result.code).toBe(1);
			expect(result.stderr).toContain("OPENAPI_DRIFT: GET /users/{id} schema changed");
		});
	});

	describe("openapi breaking", () => {
		it("never accepts drift without --update-baseline, and then writes only source facts", async () => {
			const cwd = project({
				"src/routes/users/$id/schemas.ts": userSchemas,
				"src/routes/users/$id/route.ts": userRoute(),
				"src/routes/accounts/schemas.ts": userSchemas,
				"src/routes/accounts/route.ts": userRoute().replace("/users/:id", "/accounts"),
			});
			writeBaseline(cwd, generateOpenApi(cwd));
			rmSync(join(cwd, "src/routes/accounts"), { recursive: true, force: true, maxRetries: 0 });

			const refused = await run(["openapi", "breaking"], { cwd });

			expect(refused.code).toBe(1);
			expect(refused.stderr).toContain("OPENAPI_REMOVED_OPERATION: GET /accounts");
			expect(readBaseline(cwd).paths).toHaveProperty("/accounts");

			const updated = await run(["openapi", "breaking", "--update-baseline"], { cwd });

			expect(updated.code).toBe(0);
			expect(readBaseline(cwd).paths).not.toHaveProperty("/accounts");
			expect(readBaseline(cwd)).toEqual(generateOpenApi(cwd));
		});
	});

	describe("migration from baseline carryover", () => {
		it("drops carried identity, security, statuses, components, and info when the baseline is regenerated", async () => {
			const cwd = project({
				"src/routes/users/$id/schemas.ts": userSchemas,
				"src/routes/users/$id/route.ts": userRoute({ security: false, notFound: false }),
			});
			writeBaseline(cwd, {
				openapi: "3.1.0",
				info: { title: "Users API", version: "1.0.0" },
				servers: [{ url: "https://api.example.com" }],
				paths: {
					"/users/{id}": {
						get: {
							operationId: "getUserById",
							security: [{ sessionCookie: [] }],
							parameters: [
								{ name: "id", in: "path", required: true, schema: { type: "string" } },
							],
							responses: {
								"200": {
									description: "OK",
									content: { "application/json": { schema: { $ref: "#/components/schemas/User" } } },
								},
								"404": {
									description: "Not found",
									content: { "application/json": { schema: { type: "object" } } },
								},
							},
						},
					},
				},
				components: {
					schemas: {
						User: { type: "object", required: ["id", "name"], properties: { id: { type: "string" }, name: { type: "string" } } },
						Orphan: { type: "string" },
					},
				},
			});

			const check = await run(["openapi", "check"], { cwd });

			expect(check.code).toBe(1);
			expect(check.stderr).toContain("GET /users/{id} response 404 removed");
			expect(check.stderr).toContain("GET /users/{id} security changed");

			expect((await run(["openapi", "breaking", "--update-baseline"], { cwd })).code).toBe(0);
			const migrated = readBaseline(cwd);

			expect(migrated.info).toEqual({ title: "Routa API", version: "0.0.0" });
			expect(migrated).not.toHaveProperty("servers");
			expect(operation(migrated, "/users/{id}", "get").operationId).toBe("getUsersId");
			expect(operation(migrated, "/users/{id}", "get")).not.toHaveProperty("security");
			expect(Object.keys(operation(migrated, "/users/{id}", "get").responses as Json)).toEqual([
				"200",
			]);
			expect(Object.keys((migrated.components as Json).schemas as Json)).toEqual(["User"]);
			expect((await run(["openapi", "check"], { cwd })).code).toBe(0);
		});

		it("corrects an inline baseline schema to a source component without reporting drift", async () => {
			const cwd = project({
				"src/routes/users/$id/schemas.ts": userSchemas,
				"src/routes/users/$id/route.ts": userRoute({ notFound: false }),
			});
			const accepted = generateOpenApi(cwd) as Json;
			const get = operation(accepted, "/users/{id}", "get");
			writeBaseline(cwd, {
				...accepted,
				components: undefined,
				paths: {
					"/users/{id}": {
						get: {
							...get,
							responses: {
								"200": {
									description: "OK",
									content: {
										"application/json": {
											schema: {
												type: "object",
												required: ["id", "name"],
												properties: { id: { type: "string" }, name: { type: "string" } },
											},
										},
									},
								},
							},
						},
					},
				},
			});

			expect(generateOpenApi(cwd)).toEqual(accepted);
			expect((await run(["openapi", "check"], { cwd })).code).toBe(0);
		});
	});
});

function operation(document: unknown, path: string, method: string): Json {
	return (document as { paths: Record<string, Record<string, Json>> }).paths[path][method];
}

function writeBaseline(cwd: string, document: unknown): void {
	writeFileSync(join(cwd, ".routa/openapi-baseline.json"), `${JSON.stringify(document, null, "\t")}\n`);
}

function readBaseline(cwd: string): Json {
	return JSON.parse(readFileSync(join(cwd, ".routa/openapi-baseline.json"), "utf8")) as Json;
}

/**
 * Creates a minimal Routa project in a temporary directory.
 */
function project(files: Record<string, string>): string {
	const cwd = mkdtempSync(join(tmpdir(), "routa-openapi-source-"));
	const allFiles: Record<string, string> = {
		"package.json": JSON.stringify({ type: "module" }),
		"tsconfig.json": "{}",
		"src/routa.ts":
			'import { createRouta } from "@routa-ts/core";\n\nexport default createRouta({});\n',
		".routa/.keep": "",
		...files,
	};

	for (const [file, content] of Object.entries(allFiles)) {
		mkdirSync(dirname(join(cwd, file)), { recursive: true });
		writeFileSync(join(cwd, file), content);
	}

	return cwd;
}
