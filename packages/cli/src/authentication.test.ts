import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { run } from "./index.js";
import { generateOpenApi } from "./openapi.js";
import { validateProject } from "./project.js";
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

const adminRoute = `import { createRoute, createRouteRoot, requireAuth } from "@routa-ts/core";
import { z } from "zod";

// Type assertions only; never called.
export const typeChecks = () => {
\trequireAuth({ schemes: ["userToken"] });
\t// @ts-expect-error Only schemes src/routa.ts declares.
\trequireAuth({ schemes: ["serviceKey"] });
};

export default createRouteRoot("/admin")({
\tmiddleware: [requireAuth({ schemes: ["userToken"] })],
\tget: createRoute({
\t\tresponses: { ok: { status: 200, schema: z.object({ id: z.string() }) } },
\t\trun: ({ ctx }) => ({ type: "ok", data: { id: ctx.auth.principal.id } }),
\t}),
});
`;

describe("Bearer authentication in a project", () => {
	it("types ctx.auth, narrows it after requireAuth, and serves the same contract", async () => {
		const cwd = project({
			"src/routa.ts": routaConfig,
			"src/routes/me/route.ts": meRoute,
			"src/routes/projects/route.ts": projectsRoute,
			"src/routes/admin/route.ts": adminRoute,
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
		expect((await request("/admin")).status).toBe(401);
		expect(
			await (await request("/admin", { headers: { authorization: "Bearer user-token" } })).json(),
		).toEqual({ id: "user_1" });
		await application.dispose();
	}, 30_000);
});

const plainConfig =
	'import { createRouta } from "@routa-ts/core";\n\nexport default createRouta({});\n';

function routeWith(
	middleware: string,
	imports = "createRoute, createRouteRoot, requireAuth",
): string {
	return `import { ${imports} } from "@routa-ts/core";
import { z } from "zod";

export default createRouteRoot("/projects")({
\tget: createRoute({
\t\tmiddleware: [${middleware}],
\t\tresponses: { ok: { status: 200, schema: z.object({ ok: z.boolean() }) } },
\t\trun: () => ({ type: "ok", data: { ok: true } }),
\t}),
});
`;
}

function configWith(authentication: string, prelude = ""): string {
	return `import { bearer, createRouta } from "@routa-ts/core";
import { z } from "zod";
${prelude}
const Principal = z.object({ id: z.string(), type: z.literal("user") });
const reject = () => ({ type: "rejected" }) as const;

export default createRouta({
\tauthentication: ${authentication},
});
`;
}

function diagnostics(files: Record<string, string>): Array<{ code: string; message: string }> {
	return validateProject(project(files), { write: false }).diagnostics.map(({ code, message }) => ({
		code,
		message,
	}));
}

describe("generated test applications", () => {
	it("send a Bearer credential through the authenticator", async () => {
		const cwd = project({
			"src/routa.ts": routaConfig,
			"src/routes/projects/route.ts": projectsRoute,
		});
		expectPassed(await run(["generate"], { cwd }));
		const { createTestApp } = (await import(
			pathToFileURL(join(cwd, ".routa/testing.gen.ts")).href
		)) as {
			createTestApp: () => Promise<{
				request: (path: string, init?: RequestInit) => Promise<Response>;
				dispose(): Promise<void>;
			}>;
		};
		const app = await createTestApp();
		const create = (headers: Record<string, string>) =>
			app.request("/projects", {
				method: "POST",
				headers: { "content-type": "application/json", ...headers },
				body: JSON.stringify({ name: "Atlas" }),
			});

		expect((await create({})).status).toBe(401);
		expect((await create({ authorization: "Bearer expired" })).status).toBe(401);
		expect(await (await create({ authorization: "Bearer user-token" })).json()).toEqual({
			owner: "user_1",
			name: "Atlas",
		});
		await app.dispose();
	}, 30_000);
});

describe("route reference and middleware context", () => {
	it("lists the authentication outcomes each operation can return", async () => {
		const cwd = project({
			"src/routa.ts": routaConfig,
			"src/routes/projects/route.ts": projectsRoute,
		});

		const result = await run(["routes", "--format", "json"], { cwd });
		const methods = JSON.parse(result.stdout ?? "").routes[0].methods as Array<{
			method: string;
			responses: number[];
			rejects: Array<{ type: string; status: number }>;
		}>;

		expect(
			methods.map(({ method, responses, rejects }) => ({
				method,
				responses,
				rejects: rejects.map((item) => item.type),
			})),
		).toEqual([
			{ method: "GET", responses: [200, 401], rejects: ["authenticationFailed"] },
			{
				method: "POST",
				responses: [201, 401],
				rejects: ["authenticationFailed", "authenticationRequired"],
			},
		]);
	});

	it("lets middleware require ctx.auth, which credential orchestration provides first", async () => {
		const cwd = project({
			"src/routa.ts": routaConfig,
			"src/routes/middleware.ts": `import { createMiddleware } from "@routa-ts/core";
import { z } from "zod";

export const withActor = createMiddleware({
\trequires: ["auth"],
\tprovides: { actor: z.string() },
\trun: ({ ctx, next }) =>
\t\tnext({ actor: ctx.auth.status === "authenticated" ? ctx.auth.principal.id : "anonymous" }),
});
`,
			"src/routes/projects/route.ts": projectsRoute.replace(
				'run: ({ ctx }) => ({ type: "ok", data: { visibility: ctx.auth.status } }),',
				'run: ({ ctx }) => ({ type: "ok", data: { visibility: ctx.actor } }),',
			),
		});

		expectPassed(await run(["check"], { cwd }));
		const { application } = await createProjectApplication(cwd, cwd, "dev");
		const response = await application.fetch(
			new Request("http://localhost/projects", { headers: { authorization: "Bearer user-token" } }),
		);

		expect(await response.json()).toEqual({ visibility: "user_1" });
		await application.dispose();
	}, 30_000);
});

describe("applications without authentication", () => {
	it("keep compiling without ctx.auth and reject requireAuth", async () => {
		const cwd = project({
			"src/routa.ts": plainConfig,
			"src/routes/me/route.ts": `import { createRoute, createRouteRoot } from "@routa-ts/core";
import { z } from "zod";

export default createRouteRoot("/me")({
\tget: createRoute({
\t\tresponses: { ok: { status: 200, schema: z.object({ ok: z.boolean() }) } },
\t\trun: ({ ctx }) => {
\t\t\t// @ts-expect-error ctx.auth exists only when createRouta configures authentication.
\t\t\tvoid ctx.auth;
\t\t\treturn { type: "ok", data: { ok: true } };
\t\t},
\t}),
});
`,
		});

		expectPassed(await run(["check"], { cwd }));
		expect(readFileSync(join(cwd, ".routa/routes.gen.ts"), "utf8")).not.toContain("auth");

		expect(
			diagnostics({
				"src/routa.ts": plainConfig,
				"src/routes/projects/route.ts": routeWith("requireAuth()"),
			}),
		).toEqual([
			{
				code: "ROUTA_AUTH_NOT_CONFIGURED",
				message:
					"requireAuth() in src/routes/projects/route.ts needs authentication, but src/routa.ts configures none.",
			},
		]);
	}, 30_000);
});

describe("authentication diagnostics", () => {
	const bearerConfig = configWith(
		"{ principal: Principal, schemes: { userToken: bearer({ authenticate: reject }) } }",
	);

	it("reports requireAuth options it cannot use", () => {
		const cases: Array<[string, string, string]> = [
			[
				'requireAuth({ schemes: ["serviceKey"] })',
				"ROUTA_AUTH_SCHEME_UNKNOWN",
				'requireAuth() in src/routes/projects/route.ts allows scheme "serviceKey", which src/routa.ts does not declare.',
			],
			[
				"requireAuth({ schemes: [] })",
				"ROUTA_AUTH_REQUIREMENT_EMPTY",
				"requireAuth() in src/routes/projects/route.ts allows no schemes, so no request could pass it.",
			],
			[
				"requireAuth({ schemes: allowed })",
				"ROUTA_AUTH_REQUIREMENT_UNRESOLVED",
				"requireAuth() in src/routes/projects/route.ts declares options that cannot be statically read.",
			],
			[
				"requireAuth(options)",
				"ROUTA_AUTH_REQUIREMENT_UNRESOLVED",
				"requireAuth() in src/routes/projects/route.ts declares options that cannot be statically read.",
			],
		];

		for (const [middleware, code, message] of cases) {
			expect(
				diagnostics({
					"src/routa.ts": bearerConfig,
					"src/routes/projects/route.ts": routeWith(middleware),
				}),
			).toEqual([{ code, message }]);
		}
	});

	it("reports authentication config it cannot read or accept", () => {
		const cases: Array<[string, string, string, string?]> = [
			[
				"makeAuthentication()",
				"ROUTA_AUTH_CONFIG_UNRESOLVED",
				"The authentication config in src/routa.ts cannot be statically read.",
			],
			[
				"{ principal: Principal, schemes: { [name]: bearer({ authenticate: reject }) } }",
				"ROUTA_AUTH_CONFIG_UNRESOLVED",
				"The authentication schemes in src/routa.ts cannot be statically read.",
				'const name = "userToken";',
			],
			[
				"{ principal: Principal, schemes: { userToken: makeScheme() } }",
				"ROUTA_AUTH_CONFIG_UNRESOLVED",
				'Authentication scheme "userToken" in src/routa.ts is not a statically readable bearer(), apiKey(), or sessionCookie() call.',
			],
			[
				"{ principal: Principal, schemes: { userToken: bearer({ authenticate: reject, ...dynamicChallenge() }) } }",
				"ROUTA_AUTH_CONFIG_UNRESOLVED",
				'Authentication scheme "userToken" in src/routa.ts is not a statically readable bearer(), apiKey(), or sessionCookie() call.',
				"const dynamicChallenge = () => ({ challenge: { realm: process.env.REALM ?? 'api' } });",
			],
			[
				"{ schemes: { userToken: bearer({ authenticate: reject }) } }",
				"ROUTA_AUTH_CONFIG_INVALID",
				"The authentication config in src/routa.ts declares no principal schema.",
			],
			[
				"{ principal: Principal, schemes: {} }",
				"ROUTA_AUTH_CONFIG_INVALID",
				"The authentication config in src/routa.ts declares no credential schemes.",
			],
			[
				'{ principal: Principal, schemes: { "2": bearer({ authenticate: reject }) } }',
				"ROUTA_AUTH_CONFIG_INVALID",
				'Authentication scheme name "2" must start with a letter and use only letters, digits, ".", "-", and "_".',
			],
			[
				'{ principal: Principal, schemes: { "user token": bearer({ authenticate: reject }) } }',
				"ROUTA_AUTH_CONFIG_INVALID",
				'Authentication scheme name "user token" must start with a letter and use only letters, digits, ".", "-", and "_".',
			],
			[
				"{ principal: Principal, schemes: { userToken: bearer({ authenticate: reject }), adminToken: bearer({ authenticate: reject }) } }",
				"ROUTA_AUTH_TRANSPORT_OVERLAP",
				'Authentication schemes "userToken" and "adminToken" both read the Authorization Bearer credential.',
			],
			[
				'{ principal: Principal, schemes: { userToken: bearer({ challenge: { realm: "a\\"b" }, authenticate: reject }) } }',
				"ROUTA_AUTH_CHALLENGE_INVALID",
				'Authentication scheme "userToken" declares a challenge realm that is empty or has a character outside printable ASCII, " or \\.',
			],
			[
				"{ principal: Principal, schemes: { userToken: bearer({ challenge: { realm: process.env.REALM }, authenticate: reject }) } }",
				"ROUTA_AUTH_CHALLENGE_INVALID",
				'Authentication scheme "userToken" declares a challenge realm that is not a string literal.',
			],
			[
				'{ principal: Principal, schemes: { userToken: bearer({ challenge: { scope: "read" }, authenticate: reject }) } }',
				"ROUTA_AUTH_CHALLENGE_INVALID",
				'Authentication scheme "userToken" declares challenge "scope". A Bearer challenge override accepts only realm.',
			],
			[
				"{ principal: Principal, schemes: { userToken: bearer({ challenge, authenticate: reject }) } }",
				"ROUTA_AUTH_CHALLENGE_INVALID",
				'Authentication scheme "userToken" declares a challenge override that is not a literal object.',
				'const challenge = { realm: "api" };',
			],
			[
				'{ principal: Principal, schemes: { userToken: bearer({ challenge() { return { realm: "api" }; }, authenticate: reject }) } }',
				"ROUTA_AUTH_CHALLENGE_INVALID",
				'Authentication scheme "userToken" declares a challenge override that is not a literal object.',
			],
		];

		for (const [authentication, code, message, prelude] of cases) {
			expect(diagnostics({ "src/routa.ts": configWith(authentication, prelude) })).toEqual([
				{ code, message },
			]);
		}
	});

	it("warns when a spread or config argument it cannot read may hide authentication", () => {
		const warning = {
			code: "ROUTA_AUTH_SPREAD_UNRESOLVED",
			severity: "warning",
			message:
				"The createRouta config in src/routa.ts has a spread, computed key, or config argument that cannot be statically read, so authentication inside it cannot be read.",
			file: "src/routa.ts",
			suggestion:
				"Declare authentication as a visible member of the createRouta object, after any spread, or spread a const object literal. Startup rejects authentication that routa generate could not read.",
		};

		for (const [config, warnings] of [
			["makeConfig()", [warning]],
			["{ ...makeConfig() }", [warning]],
			["{ port: 3000 }", []],
		] as const) {
			const cwd = project({
				"src/routa.ts": `import { createRouta } from "@routa-ts/core";

const makeConfig = () => ({ port: 3000 });

export default createRouta(${config});
`,
			});
			expect(
				validateProject(cwd, { write: false }).warnings.filter((item) =>
					item.code.startsWith("ROUTA_AUTH_"),
				),
				config,
			).toEqual(warnings);
		}
	});

	it("follows const bindings, aliases, and spreads to literal contract facts", () => {
		const cwd = project({
			"src/schemes.ts": `import { bearer as bearerScheme } from "@routa-ts/core";

export const userToken = bearerScheme({ challenge: { realm: "api" }, authenticate: () => ({ type: "rejected" }) });
`,
			"src/routa.ts": `import { createRouta } from "@routa-ts/core";
import { z } from "zod";
import { userToken } from "./schemes.js";

const schemes = { userToken };
const authentication = { principal: z.object({ id: z.string(), type: z.string() }), schemes };
const base = { authentication };

export default createRouta({ ...base, port: 3000 });
`,
		});

		const validation = validateProject(cwd, { write: false });

		expect(validation.diagnostics).toEqual([]);
		expect(validation.authentication).toEqual({
			schemes: [{ name: "userToken", kind: "bearer", realm: "api" }],
			multipleCredentials: "priority",
		});
	});

	it("reads an authenticate method like an authenticate property", () => {
		const validation = validateProject(
			project({
				"src/routa.ts": configWith(
					'{ principal: Principal, schemes: { userToken: bearer({ challenge: { realm: "api" }, async authenticate(token) { return token === "t" ? { type: "authenticated", principal: { id: token, type: "user" } } : { type: "rejected" }; } }) } }',
				),
			}),
			{ write: false },
		);

		expect(validation.diagnostics).toEqual([]);
		expect(validation.authentication).toEqual({
			schemes: [{ name: "userToken", kind: "bearer", realm: "api" }],
			multipleCredentials: "priority",
		});
	});

	it("rejects an application function named like a core descriptor", () => {
		expect(
			diagnostics({
				"src/routa.ts": configWith(
					"{ principal: Principal, schemes: { userToken: bearer({ authenticate: reject }) } }",
				).replace(
					'import { bearer, createRouta } from "@routa-ts/core";',
					'import { createRouta } from "@routa-ts/core";\nconst bearer = (options: unknown) => options;',
				),
			}),
		).toEqual([
			{
				code: "ROUTA_AUTH_CONFIG_UNRESOLVED",
				message:
					'Authentication scheme "userToken" in src/routa.ts is not a statically readable bearer(), apiKey(), or sessionCookie() call.',
			},
		]);
	});

	it("reports requireAuth exported from folder middleware, which would not run", () => {
		expect(
			diagnostics({
				"src/routa.ts": bearerConfig,
				"src/routes/(private)/middleware.ts": `import { requireAuth } from "@routa-ts/core";

export const signedIn = requireAuth();
`,
				"src/routes/(private)/projects/route.ts": routeWith("", "createRoute, createRouteRoot"),
			}),
		).toEqual([
			{
				code: "ROUTA_AUTH_REQUIREMENT_UNSUPPORTED",
				message:
					"src/routes/(private)/middleware.ts exports requireAuth() as signedIn, but folder middleware cannot require authentication yet, so it would not run.",
			},
		]);
	});

	it("reserves ctx.auth and the authentication outcome names", () => {
		const providesAuth = `import { createMiddleware } from "@routa-ts/core";
import { z } from "zod";

export const withAuth = createMiddleware({
\tprovides: { auth: z.string() },
\trun: ({ next }) => next({ auth: "x" }),
});
`;

		expect(
			diagnostics({
				"src/routa.ts": bearerConfig,
				"src/routes/middleware.ts": providesAuth,
				"src/routes/projects/route.ts": routeWith("", "createRoute, createRouteRoot"),
			}),
		).toEqual([
			{
				code: "ROUTA_CONTEXT_RESERVED",
				message: "Middleware withAuth provides ctx.auth, which Routa reserves for authentication.",
			},
		]);
		expect(
			diagnostics({
				"src/routa.ts": plainConfig,
				"src/routes/middleware.ts": providesAuth,
				"src/routes/projects/route.ts": routeWith("", "createRoute, createRouteRoot"),
			}),
		).toEqual([]);
		expect(
			diagnostics({
				"src/routa.ts": bearerConfig,
				"src/routes/projects/route.ts": routeWith("", "createRoute, createRouteRoot").replace(
					"responses: { ok:",
					"responses: { authenticationFailed: { status: 401 }, ok:",
				),
			}),
		).toEqual([
			{
				code: "ROUTA_OUTCOME_NAME_COLLISION",
				message:
					'Outcome "authenticationFailed" is declared by the route and by Routa authentication',
			},
		]);
		expect(
			diagnostics({
				"src/routa.ts": bearerConfig,
				"src/routes/files/route.ts": `import { createRoute, createRouteRoot, requireAuth } from "@routa-ts/core";

export default createRouteRoot("/files")({
\thead: createRoute({
\t\tmiddleware: [requireAuth()],
\t\tresponses: { authenticationFailed: { status: 403 }, ok: { status: 200 } },
\t\trun: () => ({ type: "ok" }),
\t}),
});
`,
			}),
		).toEqual([
			{
				code: "ROUTA_OUTCOME_NAME_COLLISION",
				message:
					'Outcome "authenticationFailed" is declared by the route and by Routa authentication',
			},
		]);
	});
});

describe("OpenAPI for Bearer authentication", () => {
	const challenge = { "www-authenticate": { required: true, schema: { type: "string" } } };
	const problem = (slug: string, title: string) => ({
		type: "object",
		required: ["type", "title", "status"],
		properties: {
			type: { type: "string", const: `https://routa-ts.dev/problems/${slug}` },
			title: { type: "string", const: title },
			status: { type: "number", const: 401 },
		},
	});
	const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
	const signInRejected = (name: string) => `import { z } from "zod";

export const ${name} = z.object({
\ttype: z.literal("https://api.example.invalid/problems/sign-in-rejected"),
\ttitle: z.literal("Sign-in rejected"),
\tstatus: z.literal(401),
});
`;
	const sessionsRoute = (
		name: string,
	) => `import { createRoute, createRouteRoot } from "@routa-ts/core";
import { ${name} } from "./schemas.js";

export default createRouteRoot("/sessions")({
\tpost: createRoute({
\t\tresponses: { created: { status: 201 }, rejected: { status: 401, schema: ${name} } },
\t\trun: () => ({ type: "created" }),
\t}),
});
`;

	it("declares the scheme, optional security on public operations, and required security behind requireAuth", () => {
		const document = generateOpenApi(
			project({
				"src/routa.ts": routaConfig,
				"src/routes/projects/route.ts": projectsRoute,
			}),
		) as Record<string, any>;
		const operations = document.paths["/projects"];

		expect(document.components.securitySchemes).toEqual({
			userToken: { type: "http", scheme: "bearer" },
		});
		expect(operations.get.security).toEqual([{}, { userToken: [] }]);
		expect(operations.post.security).toEqual([{ userToken: [] }]);
		expect(operations.get.responses["401"]).toEqual({
			description:
				"Authentication failed: the request presented a credential that is malformed, unsupported, or rejected.",
			headers: challenge,
			content: {
				"application/json": { schema: ref("RoutaAuthenticationFailed") },
			},
		});
		expect(operations.post.responses["401"]).toEqual({
			description: [
				"- `authenticationFailed`: Authentication failed: the request presented a credential that is malformed, unsupported, or rejected.",
				"- `authenticationRequired`: Authentication is required: the request presented no credential.",
			].join("\n"),
			headers: challenge,
			content: {
				"application/json": {
					schema: {
						oneOf: [ref("RoutaAuthenticationFailed"), ref("RoutaAuthenticationRequired")],
						discriminator: {
							propertyName: "type",
							mapping: {
								"https://routa-ts.dev/problems/authentication-failed":
									"#/components/schemas/RoutaAuthenticationFailed",
								"https://routa-ts.dev/problems/authentication-required":
									"#/components/schemas/RoutaAuthenticationRequired",
							},
						},
					},
				},
			},
		});
		expect(document.components.schemas).toEqual({
			RoutaAuthenticationFailed: problem("authentication-failed", "Authentication failed"),
			RoutaAuthenticationRequired: problem("authentication-required", "Authentication required"),
		});
	});

	it("lets a discriminator select every 401 body, Routa's and the application's", () => {
		const document = generateOpenApi(
			project({
				"src/routa.ts": routaConfig,
				"src/routes/projects/route.ts": projectsRoute,
				"src/routes/sessions/schemas.ts": signInRejected("SignInRejected"),
				"src/routes/sessions/route.ts": sessionsRoute("SignInRejected"),
			}),
		) as Record<string, any>;
		const body = (path: string, method: string) =>
			document.paths[path][method].responses["401"].content["application/json"].schema;

		expect(document["x-routa-diagnostics"]).toBeUndefined();
		expect(body("/projects", "get")).toEqual(ref("RoutaAuthenticationFailed"));
		expect(document.components.schemas.RoutaAuthenticationFailed).toEqual(
			problem("authentication-failed", "Authentication failed"),
		);

		for (const [path, method, names] of [
			["/projects", "post", ["RoutaAuthenticationFailed", "RoutaAuthenticationRequired"]],
			["/sessions", "post", ["RoutaAuthenticationFailed", "SignInRejected"]],
		] as const) {
			const schema = body(path, method);
			const { propertyName, mapping } = schema.discriminator;

			expect(schema.oneOf).toEqual(names.map(ref));
			expect(propertyName).toBe("type");
			expect(mapping).toEqual(
				Object.fromEntries(
					names.map((name) => [
						document.components.schemas[name].properties.type.const,
						`#/components/schemas/${name}`,
					]),
				),
			);
		}
	});

	it("refuses an application schema that claims the component of a Routa problem body", () => {
		const statusRoute = (name: string, schema: string) => ({
			"src/routes/status/schemas.ts": `import { z } from "zod";\n\nexport const ${name} = ${schema};\n`,
			"src/routes/status/route.ts": `import { createRoute, createRouteRoot } from "@routa-ts/core";
import { ${name} } from "./schemas.js";

export default createRouteRoot("/status")({
\tget: createRoute({
\t\tresponses: { ok: { status: 200, schema: ${name} } },
\t\trun: () => ({ type: "ok", data: { healthy: true } }),
\t}),
});
`,
		});
		const claimed = statusRoute("RoutaAuthenticationFailed", "z.object({ healthy: z.boolean() })");
		const collision = {
			code: "ROUTA_SCHEMA_COMPONENT_COLLISION",
			message:
				"A schema in src/routes/status/schemas.ts claims component RoutaAuthenticationFailed, which holds Routa's authenticationFailed problem body.",
		};

		// Routa places its component after the route's own outcome, and before a later route's.
		expect(diagnostics({ "src/routa.ts": routaConfig, ...claimed })).toEqual([collision]);
		expect(
			diagnostics({
				"src/routa.ts": routaConfig,
				"src/routes/projects/route.ts": projectsRoute,
				...claimed,
			}),
		).toEqual([collision]);
		expect(
			diagnostics({
				"src/routa.ts": routaConfig,
				"src/routes/projects/route.ts": projectsRoute,
				...statusRoute(
					"Health",
					'z.object({ healthy: z.boolean() }).meta({ id: "RoutaAuthenticationRequired" })',
				),
			}),
		).toEqual([
			{
				code: "ROUTA_SCHEMA_COMPONENT_COLLISION",
				message:
					"A schema in src/routes/status/schemas.ts claims component RoutaAuthenticationRequired, which holds Routa's authenticationRequired problem body.",
			},
		]);
		// Without authentication, Routa places no problem bodies, so the names stay free.
		expect(diagnostics({ "src/routa.ts": plainConfig, ...claimed })).toEqual([]);
	});

	it("documents the 401 bodies and challenges the running application sends", async () => {
		const cwd = project({
			"src/routa.ts": routaConfig,
			"src/routes/projects/route.ts": projectsRoute,
		});
		expectPassed(await run(["generate"], { cwd }));
		const document = generateOpenApi(cwd) as Record<string, any>;
		const { application } = await createProjectApplication(cwd, cwd, "dev");
		const documented = document.paths["/projects"].post.responses["401"];
		const { propertyName, mapping } = documented.content["application/json"].schema
			.discriminator as { propertyName: string; mapping: Record<string, string> };

		for (const headers of [{}, { authorization: "Bearer expired" }] as Array<
			Record<string, string>
		>) {
			const response = await application.fetch(
				new Request("http://localhost/projects", {
					method: "POST",
					headers: { "content-type": "application/json", ...headers },
					body: JSON.stringify({ name: "Atlas" }),
				}),
			);
			const body = (await response.json()) as Record<string, unknown>;
			// Select the body's schema the way a discriminator-driven client does.
			const component = mapping[String(body[propertyName])]!.replace("#/components/schemas/", "");
			const schema = document.components.schemas[component] as {
				required: string[];
				properties: Record<string, { const: unknown }>;
			};

			expect(response.status).toBe(401);
			expect(Object.keys(documented.headers)).toEqual(["www-authenticate"]);
			expect(response.headers.get("www-authenticate")).toBeTruthy();
			expect(Object.keys(body).sort()).toEqual([...schema!.required].sort());
			expect(body).toEqual(
				Object.fromEntries(
					Object.entries(schema!.properties).map(([key, value]) => [key, value.const]),
				),
			);
		}

		await application.dispose();
	}, 30_000);

	it("documents a HEAD operation's authentication failures without a body", () => {
		const document = generateOpenApi(
			project({
				"src/routa.ts": routaConfig,
				"src/routes/files/route.ts": `import { createRoute, createRouteRoot, requireAuth } from "@routa-ts/core";

export default createRouteRoot("/files")({
\thead: createRoute({
\t\tmiddleware: [requireAuth()],
\t\tresponses: { ok: { status: 200 } },
\t\trun: () => ({ type: "ok" }),
\t}),
});
`,
			}),
		) as Record<string, any>;

		expect(document["x-routa-diagnostics"]).toBeUndefined();
		expect(document.paths["/files"].head.responses["401"]).toEqual({
			description: [
				"- `authenticationFailed`: Authentication failed: the request presented a credential that is malformed, unsupported, or rejected.",
				"- `authenticationRequired`: Authentication is required: the request presented no credential.",
			].join("\n"),
			headers: challenge,
		});
		expect(document.components.schemas).toBeUndefined();
	});

	it("reports only requireAuth operations as newly requiring authentication", async () => {
		const unguarded = projectsRoute.replace("middleware: [requireAuth()],", "");
		const cwd = project({ "src/routa.ts": plainConfig, "src/routes/projects/route.ts": unguarded });
		mkdirSync(join(cwd, ".routa"), { recursive: true });
		writeFileSync(join(cwd, ".routa/openapi-baseline.json"), JSON.stringify(generateOpenApi(cwd)));
		writeFileSync(join(cwd, "src/routa.ts"), routaConfig);
		writeFileSync(join(cwd, "src/routes/projects/route.ts"), projectsRoute);

		const breaking = await run(["openapi", "breaking"], { cwd });

		expect(breaking.code).toBe(1);
		expect(breaking.stderr).toContain(
			"OPENAPI_TIGHTER_AUTH: POST /projects now requires authentication",
		);
		expect(breaking.stderr).not.toContain("GET /projects");
	});

	it("reports requireAuth behind application-owned security as newly requiring a credential", async () => {
		const tenantKey = `import { createMiddleware } from "@routa-ts/core";

export const withTenantKey = createMiddleware({
\topenapi: { security: [{ tenantKey: [] }] },
\trun: ({ next }) => next(),
});
`;
		const cwd = project({
			"src/routa.ts": plainConfig,
			"src/routes/middleware.ts": tenantKey,
			"src/routes/projects/route.ts": projectsRoute.replace("middleware: [requireAuth()],", ""),
		});
		mkdirSync(join(cwd, ".routa"), { recursive: true });
		writeFileSync(join(cwd, ".routa/openapi-baseline.json"), JSON.stringify(generateOpenApi(cwd)));
		writeFileSync(join(cwd, "src/routa.ts"), routaConfig);
		writeFileSync(join(cwd, "src/routes/projects/route.ts"), projectsRoute);

		const breaking = await run(["openapi", "breaking"], { cwd });

		expect(breaking.code).toBe(1);
		expect(breaking.stderr).toContain(
			"OPENAPI_TIGHTER_AUTH: POST /projects now requires authentication",
		);
		expect(breaking.stderr).not.toContain("GET /projects");
	});

	it("combines application-owned middleware security with authentication", () => {
		const document = generateOpenApi(
			project({
				"src/routa.ts": routaConfig,
				"src/routes/projects/route.ts": projectsRoute,
				"src/routes/middleware.ts": `import { createMiddleware } from "@routa-ts/core";

export const withTenantKey = createMiddleware({
\topenapi: { security: [{ tenantKey: [] }] },
\trun: ({ next }) => next(),
});
`,
			}),
		) as Record<string, any>;
		const operations = document.paths["/projects"];

		expect(operations.get.security).toEqual([{ tenantKey: [] }, { tenantKey: [], userToken: [] }]);
		expect(operations.post.security).toEqual([{ tenantKey: [], userToken: [] }]);
	});
});

const multiSchemeConfig = (
	options = "",
) => `import { apiKey, bearer, createRouta, sessionCookie } from "@routa-ts/core";
import { z } from "zod";

const Principal = z.discriminatedUnion("type", [
\tz.object({ type: z.literal("user"), id: z.string() }),
\tz.object({ type: z.literal("service"), id: z.string() }),
]);

export default createRouta({
\tauthentication: {
\t\tprincipal: Principal,
\t\tschemes: {
\t\t\tuserToken: bearer({
\t\t\t\tauthenticate: (token) =>
\t\t\t\t\ttoken === "user-token" ? { type: "authenticated", principal: { type: "user", id: "user_1" } } : { type: "rejected" },
\t\t\t}),
\t\t\tserviceKey: apiKey({
\t\t\t\theader: "X-Api-Key",
\t\t\t\tchallenge: { realm: "partners" },
\t\t\t\tauthenticate: async (key, { logger }) => {
\t\t\t\t\tlogger.debug("auth.key", "Checking a service key.");
\t\t\t\t\treturn key === "service-key" ? { type: "authenticated", principal: { type: "service", id: "svc_1" } } : { type: "rejected" };
\t\t\t\t},
\t\t\t}),
\t\t\tsession: sessionCookie({
\t\t\t\tcookie: "session",
\t\t\t\tauthenticate: (value) =>
\t\t\t\t\tvalue === "session-id" ? { type: "authenticated", principal: { type: "user", id: "user_2" } } : { type: "rejected" },
\t\t\t}),
\t\t},
\t\tpriority: ["session", "userToken", "serviceKey"],${options}
\t},
});
`;

const reportsRoute = `import { createRoute, createRouteRoot, requireAuth } from "@routa-ts/core";
import { z } from "zod";

export default createRouteRoot("/reports")({
\tget: createRoute({
\t\tresponses: { ok: { status: 200, schema: z.object({ who: z.string() }) } },
\t\trun: ({ ctx }) => {
\t\t\tif (ctx.auth.status === "anonymous") {
\t\t\t\treturn { type: "ok", data: { who: "anonymous" } };
\t\t\t}

\t\t\tconst scheme: "userToken" | "serviceKey" | "session" = ctx.auth.scheme;
\t\t\treturn { type: "ok", data: { who: \`\${scheme}:\${ctx.auth.principal.id}\` } };
\t\t},
\t}),
\tpost: createRoute({
\t\tmiddleware: [requireAuth({ schemes: ["session"] })],
\t\tresponses: { created: { status: 201, schema: z.object({ who: z.string() }) } },
\t\trun: ({ ctx }) => {
\t\t\tconst scheme: "session" = ctx.auth.scheme;
\t\t\treturn { type: "created", data: { who: \`\${scheme}:\${ctx.auth.principal.id}\` } };
\t\t},
\t}),
\tput: createRoute({
\t\tmiddleware: [requireAuth({ schemes: ["serviceKey", "userToken"] })],
\t\tresponses: { ok: { status: 200, schema: z.object({ who: z.string() }) } },
\t\trun: ({ ctx }) => ({ type: "ok", data: { who: ctx.auth.scheme } }),
\t}),
});
`;

describe("session-cookie and API-key authentication in a project", () => {
	it("checks, generates priority order, and serves the same selection rules", async () => {
		const cwd = project({
			"src/routa.ts": multiSchemeConfig('\n\t\tmultipleCredentials: "reject",'),
			"src/routes/reports/route.ts": reportsRoute,
		});

		expectPassed(await run(["check"], { cwd }));
		expect(readFileSync(join(cwd, ".routa/routes.gen.ts"), "utf8")).toContain(
			'export const routaAuthenticationSchemes = [\n\t"session",\n\t"userToken",\n\t"serviceKey"\n] as const;',
		);
		expect(readFileSync(join(cwd, ".routa/routes.gen.ts"), "utf8")).toContain(
			'export const routaMultipleCredentials = "reject" as const;',
		);

		const { application } = await createProjectApplication(cwd, cwd, "dev");
		const request = async (method: string, headers: Record<string, string>) => {
			const response = await application.fetch(
				new Request("http://localhost/reports", { method, headers }),
			);
			return [response.status, response.headers.get("www-authenticate"), await response.json()];
		};

		expect(await request("GET", { "x-api-key": "service-key" })).toEqual([
			200,
			null,
			{ who: "serviceKey:svc_1" },
		]);
		expect(await request("GET", { cookie: "session=session-id" })).toEqual([
			200,
			null,
			{ who: "session:user_2" },
		]);
		expect(await request("GET", { cookie: "session=wrong" })).toEqual([
			401,
			"Session",
			expect.objectContaining({ title: "Authentication failed" }),
		]);
		expect(
			await request("GET", { authorization: "Bearer user-token", cookie: "session=session-id" }),
		).toEqual([
			400,
			null,
			{
				type: "https://routa-ts.dev/problems/ambiguous-credentials",
				title: "Ambiguous credentials",
				status: 400,
			},
		]);
		expect(await request("POST", { authorization: "Bearer user-token" })).toEqual([
			401,
			"Session",
			expect.objectContaining({ title: "Authentication failed" }),
		]);
		expect(
			await request("POST", { authorization: "Bearer user-token", cookie: "session=session-id" }),
		).toEqual([201, null, { who: "session:user_2" }]);
		expect(await request("PUT", {})).toEqual([
			401,
			'Bearer, ApiKey realm="partners"',
			expect.objectContaining({ title: "Authentication required" }),
		]);
		await application.dispose();
	}, 30_000);

	it("lists ambiguousCredentials only where strict mode can return it", async () => {
		const cwd = project({
			"src/routa.ts": multiSchemeConfig('\n\t\tmultipleCredentials: "reject",'),
			"src/routes/reports/route.ts": reportsRoute,
		});

		const result = await run(["routes", "--format", "json"], { cwd });
		const methods = JSON.parse(result.stdout ?? "").routes[0].methods as Array<{
			method: string;
			responses: number[];
			rejects: Array<{ type: string }>;
		}>;

		expect(
			methods.map(({ method, responses, rejects }) => ({
				method,
				responses,
				rejects: rejects.map((item) => item.type),
			})),
		).toEqual([
			{
				method: "GET",
				responses: [200, 400, 401],
				rejects: ["ambiguousCredentials", "authenticationFailed"],
			},
			{
				method: "POST",
				responses: [201, 401],
				rejects: ["authenticationFailed", "authenticationRequired"],
			},
			{
				method: "PUT",
				responses: [200, 400, 401],
				rejects: ["ambiguousCredentials", "authenticationFailed", "authenticationRequired"],
			},
		]);
	});
});

describe("OpenAPI for session-cookie and API-key authentication", () => {
	const ambiguous = {
		description:
			"Ambiguous credentials: the request presented credentials of more than one scheme the operation accepts.",
		content: {
			"application/json": {
				schema: {
					type: "object",
					required: ["type", "title", "status"],
					properties: {
						type: {
							type: "string",
							const: "https://routa-ts.dev/problems/ambiguous-credentials",
						},
						title: { type: "string", const: "Ambiguous credentials" },
						status: { type: "number", const: 400 },
					},
				},
			},
		},
	};

	it("declares each scheme and its alternatives in priority order", () => {
		const document = generateOpenApi(
			project({
				"src/routa.ts": multiSchemeConfig(),
				"src/routes/reports/route.ts": reportsRoute,
			}),
		) as Record<string, any>;
		const operations = document.paths["/reports"];

		expect(document.components.securitySchemes).toEqual({
			session: { type: "apiKey", in: "cookie", name: "session" },
			userToken: { type: "http", scheme: "bearer" },
			serviceKey: { type: "apiKey", in: "header", name: "X-Api-Key" },
		});
		expect(operations.get.security).toEqual([
			{},
			{ session: [] },
			{ userToken: [] },
			{ serviceKey: [] },
		]);
		expect(operations.post.security).toEqual([{ session: [] }]);
		expect(operations.put.security).toEqual([{ userToken: [] }, { serviceKey: [] }]);
		expect(Object.keys(operations.get.responses)).toEqual(["200", "401"]);
	});

	it("documents ambiguousCredentials where strict mode applies", () => {
		const document = generateOpenApi(
			project({
				"src/routa.ts": multiSchemeConfig('\n\t\tmultipleCredentials: "reject",'),
				"src/routes/reports/route.ts": reportsRoute,
				"src/routes/files/route.ts": `import { createRoute, createRouteRoot } from "@routa-ts/core";

export default createRouteRoot("/files")({
\thead: createRoute({ responses: { ok: { status: 200 } }, run: () => ({ type: "ok" }) }),
});
`,
			}),
		) as Record<string, any>;
		const operations = document.paths["/reports"];

		expect(document["x-routa-diagnostics"]).toBeUndefined();
		expect(operations.get.responses["400"]).toEqual(ambiguous);
		expect(operations.put.responses["400"]).toEqual(ambiguous);
		expect(operations.post.responses["400"]).toBeUndefined();
		expect(document.paths["/files"].head.responses["400"]).toEqual({
			description: ambiguous.description,
		});
	});
});

describe("session-cookie and API-key diagnostics", () => {
	const config = (schemes: string, options = "") =>
		configWith(`{ principal: Principal, schemes: { ${schemes} }${options} }`).replace(
			'import { bearer, createRouta } from "@routa-ts/core";',
			'import { apiKey, bearer, createRouta, sessionCookie } from "@routa-ts/core";',
		);
	const key = (header: string) => `apiKey({ header: ${header}, authenticate: reject })`;
	const cookie = (name: string) => `sessionCookie({ cookie: ${name}, authenticate: reject })`;
	const two = `a: ${key('"x-a"')}, b: ${cookie('"b"')}`;

	it("reports overlapping and invalid transports", () => {
		const cases: Array<[string, string, string]> = [
			[
				`a: ${key('"X-Api-Key"')}, b: ${key('"x-api-key"')}`,
				"ROUTA_AUTH_TRANSPORT_OVERLAP",
				'Authentication schemes "a" and "b" both read the x-api-key header.',
			],
			[
				`a: ${cookie('"sid"')}, b: ${cookie('"sid"')}`,
				"ROUTA_AUTH_TRANSPORT_OVERLAP",
				'Authentication schemes "a" and "b" both read the "sid" cookie.',
			],
			[
				`a: ${key('"Authorization"')}`,
				"ROUTA_AUTH_TRANSPORT_OVERLAP",
				'Authentication scheme "a" reads the Authorization header, which carries Authorization-scheme credentials such as Bearer.',
			],
			[
				`a: ${key('"cookie"')}`,
				"ROUTA_AUTH_TRANSPORT_OVERLAP",
				'Authentication scheme "a" reads the Cookie header, which carries cookies.',
			],
			[
				`a: ${key('"x api key"')}`,
				"ROUTA_AUTH_CONFIG_INVALID",
				'Authentication scheme "a" declares header "x api key", which is not an HTTP header name.',
			],
			[
				`a: ${cookie('"se;ssion"')}`,
				"ROUTA_AUTH_CONFIG_INVALID",
				'Authentication scheme "a" declares cookie "se;ssion", which is not a cookie name.',
			],
			[
				`a: ${key("process.env.HEADER")}`,
				"ROUTA_AUTH_CONFIG_UNRESOLVED",
				'Authentication scheme "a" declares a header that is not a string literal.',
			],
			[
				`a: ${cookie("name")}`,
				"ROUTA_AUTH_CONFIG_UNRESOLVED",
				'Authentication scheme "a" declares a cookie that is not a string literal.',
			],
			[
				'a: apiKey({ header: "x-a", challenge: { scope: "x" }, authenticate: reject })',
				"ROUTA_AUTH_CHALLENGE_INVALID",
				'Authentication scheme "a" declares challenge "scope". An ApiKey challenge override accepts only realm.',
			],
			[
				'a: sessionCookie({ cookie: "sid", challenge: { realm: "" }, authenticate: reject })',
				"ROUTA_AUTH_CHALLENGE_INVALID",
				'Authentication scheme "a" declares a challenge realm that is empty or has a character outside printable ASCII, " or \\.',
			],
		];

		for (const [schemes, code, message] of cases) {
			expect(diagnostics({ "src/routa.ts": config(schemes) }), schemes).toEqual([
				{ code, message },
			]);
		}
	});

	it("reports priority and multipleCredentials it cannot use", () => {
		const cases: Array<[string, string, string]> = [
			[
				', priority: ["a", "b", "c"]',
				"ROUTA_AUTH_SCHEME_UNKNOWN",
				'The authentication priority in src/routa.ts lists "c", which schemes does not declare.',
			],
			[
				', priority: ["a", "b", "a"]',
				"ROUTA_AUTH_PRIORITY_INVALID",
				'The authentication priority in src/routa.ts lists "a" more than once.',
			],
			[
				', priority: ["b"]',
				"ROUTA_AUTH_PRIORITY_INVALID",
				'The authentication priority in src/routa.ts omits "a".',
			],
			[
				", priority: order",
				"ROUTA_AUTH_CONFIG_UNRESOLVED",
				"The authentication priority in src/routa.ts is not a literal list of scheme names.",
			],
			[
				', multipleCredentials: "first"',
				"ROUTA_AUTH_CONFIG_INVALID",
				'The authentication multipleCredentials in src/routa.ts is "first". Use "priority" or "reject".',
			],
			[
				", multipleCredentials: mode",
				"ROUTA_AUTH_CONFIG_UNRESOLVED",
				'The authentication multipleCredentials in src/routa.ts is not the literal "priority" or "reject".',
			],
		];

		for (const [options, code, message] of cases) {
			expect(diagnostics({ "src/routa.ts": config(two, options) }), options).toEqual([
				{ code, message },
			]);
		}
	});

	it("reads priority, multipleCredentials, and transports as contract facts", () => {
		const validation = validateProject(
			project({
				"src/routa.ts": config(
					`${two}, c: apiKey({ header: "X-B", challenge: { realm: "partners" }, authenticate: reject })`,
					', priority: ["c", "a", "b"], multipleCredentials: "reject"',
				),
			}),
			{ write: false },
		);

		expect(validation.diagnostics).toEqual([]);
		expect(validation.authentication).toEqual({
			multipleCredentials: "reject",
			schemes: [
				{ name: "c", kind: "apiKey", header: "X-B", realm: "partners" },
				{ name: "a", kind: "apiKey", header: "x-a" },
				{ name: "b", kind: "sessionCookie", cookie: "b" },
			],
		});
	});

	it("reports route and method requirements that allow no scheme in common", () => {
		expect(
			diagnostics({
				"src/routa.ts": config(two),
				"src/routes/projects/route.ts": `import { createRoute, createRouteRoot, requireAuth } from "@routa-ts/core";
import { z } from "zod";

export default createRouteRoot("/projects")({
\tmiddleware: [requireAuth({ schemes: ["a"] })],
\tget: createRoute({
\t\tmiddleware: [requireAuth({ schemes: ["b"] })],
\t\tresponses: { ok: { status: 200, schema: z.object({ ok: z.boolean() }) } },
\t\trun: () => ({ type: "ok", data: { ok: true } }),
\t}),
});
`,
			}),
		).toEqual([
			{
				code: "ROUTA_AUTH_REQUIREMENT_EMPTY",
				message:
					"requireAuth() guards on GET /projects allow no scheme in common, so no request could pass them.",
			},
		]);
	});

	it("reserves ambiguousCredentials where strict mode applies", () => {
		const route = routeWith("", "createRoute, createRouteRoot").replace(
			"responses: { ok:",
			"responses: { ambiguousCredentials: { status: 400 }, ok:",
		);

		expect(
			diagnostics({
				"src/routa.ts": config(two, ', multipleCredentials: "reject"'),
				"src/routes/projects/route.ts": route,
			}),
		).toEqual([
			{
				code: "ROUTA_OUTCOME_NAME_COLLISION",
				message:
					'Outcome "ambiguousCredentials" is declared by the route and by Routa authentication',
			},
		]);
		expect(
			diagnostics({ "src/routa.ts": config(two), "src/routes/projects/route.ts": route }),
		).toEqual([]);
	});
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
					"@routa-ts/core/hono": [join(repoRoot, "packages/core/src/hono.ts")],
					"@routa-ts/core/testing": [join(repoRoot, "packages/core/src/testing.ts")],
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
