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
			"src/routes/middleware.ts": "export {};\n",
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
		const generated = readFileSync(join(cwd, ".routa/routes.gen.ts"), "utf8");
		expect(generated).not.toContain("auth");
		// Only an application with authentication checks folder middleware for guards at startup.
		expect(generated).not.toContain("middlewareFiles");

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

/** An application-owned guard, named like the built-in one, with its own 401 reject. */
function applicationGuard(rejectSchema: string): string {
	return `import { createMiddleware } from "@routa-ts/core";
import { z } from "zod";

export const requireAuth = createMiddleware({
\tinput: { headers: z.object({ "x-session": z.string().optional() }) },
\tprovides: { user: z.string() },
\trejects: { unauthorized: { status: 401, schema: ${rejectSchema} } },
\trun: ({ input, next }) =>
\t\tinput.headers["x-session"] === "app-session"
\t\t\t? next({ user: "app_user" })
\t\t\t: ({ type: "unauthorized", data: { type: "unauthorized" } } as const),
});
`;
}

/** A route guarded by the application-owned middleware, reading what it provides. */
function applicationGuardedRoute(readAuth: boolean): string {
	return `import { createRoute, createRouteRoot } from "@routa-ts/core";
import { z } from "zod";
import { requireAuth } from "../../middleware/auth.js";

export default createRouteRoot("/projects")({
\tget: createRoute({
\t\tmiddleware: [requireAuth],
\t\tresponses: { ok: { status: 200, schema: z.object({ user: z.string(), auth: z.string() }) } },
\t\trun: ({ ctx }) => ({
\t\t\ttype: "ok",
\t\t\tdata: { user: ctx.user, auth: ${readAuth ? "ctx.auth.status" : '"none"'} },
\t\t}),
\t}),
});
`;
}

describe("application-owned authentication middleware", () => {
	const guardBody = 'z.object({ type: z.literal("unauthorized") })';

	async function serve(cwd: string, headers: Record<string, string>) {
		const { application } = await createProjectApplication(cwd, cwd, "dev");
		try {
			const response = await application.fetch(
				new Request("http://localhost/projects", { headers }),
			);
			return {
				status: response.status,
				challenge: response.headers.get("www-authenticate"),
				body: await response.json(),
			};
		} finally {
			await application.dispose();
		}
	}

	it("keeps working in an application without authentication", async () => {
		const cwd = project({
			"src/routa.ts": plainConfig,
			"src/middleware/auth.ts": applicationGuard(guardBody),
			"src/routes/projects/route.ts": applicationGuardedRoute(false),
		});

		expectPassed(await run(["check"], { cwd }));
		expect(await serve(cwd, {})).toEqual({
			status: 401,
			challenge: null,
			body: { type: "unauthorized" },
		});
		expect(await serve(cwd, { "x-session": "app-session" })).toEqual({
			status: 200,
			challenge: null,
			body: { user: "app_user", auth: "none" },
		});
	}, 30_000);

	it("keeps working beside configured authentication, which runs first", async () => {
		const cwd = project({
			"src/routa.ts": routaConfig,
			"src/middleware/auth.ts": applicationGuard(guardBody),
			"src/routes/projects/route.ts": applicationGuardedRoute(true),
		});

		expectPassed(await run(["check"], { cwd }));
		// Routa reads it as ordinary middleware, not as the built-in guard.
		expect(await serve(cwd, {})).toEqual({
			status: 401,
			challenge: null,
			body: { type: "unauthorized" },
		});
		expect(await serve(cwd, { "x-session": "app-session" })).toEqual({
			status: 200,
			challenge: null,
			body: { user: "app_user", auth: "anonymous" },
		});
		expect(
			await serve(cwd, { "x-session": "app-session", authorization: "Bearer user-token" }),
		).toEqual({ status: 200, challenge: null, body: { user: "app_user", auth: "authenticated" } });
		// A presented invalid credential fails closed before application middleware runs.
		expect(
			await serve(cwd, { "x-session": "app-session", authorization: "Bearer expired" }),
		).toEqual({
			status: 401,
			challenge: 'Bearer realm="api", error="invalid_token"',
			body: {
				type: "https://routa-ts.dev/problems/authentication-failed",
				title: "Authentication failed",
				status: 401,
			},
		});
	}, 30_000);

	it("must tell its 401 apart from authenticationFailed once authentication is configured", () => {
		const codes = (config: string, body = "z.object({ type: z.string() })") =>
			diagnostics({
				"src/routa.ts": config,
				"src/middleware/auth.ts": applicationGuard(body),
				"src/routes/projects/route.ts": applicationGuardedRoute(false),
			}).map(({ code }) => code);

		expect(codes(plainConfig)).toEqual([]);
		expect(codes(routaConfig)).toEqual(["ROUTA_RESPONSE_STATUS_AMBIGUOUS"]);
		// A literal on a property Routa's bodies lack tells nothing apart.
		expect(codes(routaConfig, 'z.object({ kind: z.literal("unauthorized") })')).toEqual([
			"ROUTA_RESPONSE_STATUS_AMBIGUOUS",
		]);
		// A distinct literal on a property every 401 body requires, type or title, does.
		expect(
			codes(
				routaConfig,
				'z.object({ type: z.literal("https://example.com/problems/unauthorized") })',
			),
		).toEqual([]);
		expect(codes(routaConfig, 'z.object({ title: z.literal("Unauthorized") })')).toEqual([]);
	});
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
				'Authentication scheme "userToken" in src/routa.ts is not a statically readable bearer(), apiKey(), sessionCookie(), or custom() call.',
			],
			[
				"{ principal: Principal, schemes: { userToken: bearer({ authenticate: reject, ...dynamicChallenge() }) } }",
				"ROUTA_AUTH_CONFIG_UNRESOLVED",
				'Authentication scheme "userToken" in src/routa.ts is not a statically readable bearer(), apiKey(), sessionCookie(), or custom() call.',
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
					'Authentication scheme "userToken" in src/routa.ts is not a statically readable bearer(), apiKey(), sessionCookie(), or custom() call.',
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
	const ambiguousBody = {
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
	};
	const ambiguous = {
		description:
			"Ambiguous credentials: the request presented credentials of more than one scheme the operation accepts.",
		content: {
			"application/json": {
				schema: { $ref: "#/components/schemas/RoutaAmbiguousCredentials" },
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
		expect(document.components.schemas.RoutaAmbiguousCredentials).toEqual(ambiguousBody);
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
					'requireAuth() guards on GET /projects allow no scheme in common, so no request could pass them: src/routes/projects/route.ts allows "a"; src/routes/projects/route.ts allows "b".',
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

/** Three schemes whose authenticators record each call in `globalThis.routaAuthCalls`. */
const countingConfig = `import { apiKey, bearer, createRouta, sessionCookie } from "@routa-ts/core";
import { z } from "zod";

const record = (scheme: string) => {
\t(globalThis as unknown as { routaAuthCalls?: string[] }).routaAuthCalls?.push(scheme);
};

export default createRouta({
\tauthentication: {
\t\tprincipal: z.object({ id: z.string(), type: z.string() }),
\t\tschemes: {
\t\t\tuserToken: bearer({
\t\t\t\tauthenticate: (token) => {
\t\t\t\t\trecord("userToken");
\t\t\t\t\treturn token === "user-token" ? { type: "authenticated", principal: { type: "user", id: "user_1" } } : { type: "rejected" };
\t\t\t\t},
\t\t\t}),
\t\t\tserviceKey: apiKey({
\t\t\t\theader: "x-api-key",
\t\t\t\tauthenticate: (key) => {
\t\t\t\t\trecord("serviceKey");
\t\t\t\t\treturn key === "service-key" ? { type: "authenticated", principal: { type: "service", id: "svc_1" } } : { type: "rejected" };
\t\t\t\t},
\t\t\t}),
\t\t\tsession: sessionCookie({
\t\t\t\tcookie: "session",
\t\t\t\tauthenticate: (value) => {
\t\t\t\t\trecord("session");
\t\t\t\t\treturn value === "session-id" ? { type: "authenticated", principal: { type: "user", id: "user_2" } } : { type: "rejected" };
\t\t\t\t},
\t\t\t}),
\t\t},
\t\tpriority: ["session", "userToken", "serviceKey"],
\t},
});
`;

/** Generic middleware and requireAuth guards at every placement of the filesystem hierarchy. */
const composedRoutes: Record<string, string> = {
	"src/guards.ts": `import { requireAuth } from "@routa-ts/core";

export const sessionOnly = requireAuth({ schemes: ["session"] });
`,
	"src/routes/middleware.ts": `import { createMiddleware } from "@routa-ts/core";
import { z } from "zod";

export const withActor = createMiddleware({
\trequires: ["auth"],
\tprovides: { actor: z.string() },
\trun: ({ ctx, next }) =>
\t\tnext({ actor: ctx.auth.status === "authenticated" ? ctx.auth.principal.id : "anonymous" }),
});
`,
	"src/routes/public/route.ts": `import { createRoute, createRouteRoot } from "@routa-ts/core";
import { z } from "zod";

export default createRouteRoot("/public")({
\tget: createRoute({
\t\tresponses: { ok: { status: 200, schema: z.object({ actor: z.string() }) } },
\t\trun: ({ ctx }) => {
\t\t\t// Type assertions only; never called.
\t\t\tconst typeChecks = () => {
\t\t\t\t// @ts-expect-error No guard protects this route, so narrow before reading the principal.
\t\t\t\tvoid ctx.auth.principal;
\t\t\t};
\t\t\tvoid typeChecks;
\t\t\treturn { type: "ok", data: { actor: ctx.actor } };
\t\t},
\t}),
});
`,
	"src/routes/(staff)/middleware.ts": `import { createMiddleware, requireAuth } from "@routa-ts/core";
import { z } from "zod";

export const staff = requireAuth({ schemes: ["userToken", "session"] });

export const withBadge = createMiddleware({
\trequires: ["actor"],
\tprovides: { badge: z.string() },
\trun: ({ ctx, next }) => next({ badge: \`staff:\${ctx.actor}\` }),
});
`,
	"src/routes/(staff)/reports/route.ts": `import { createRoute, createRouteRoot, requireAuth } from "@routa-ts/core";
import { z } from "zod";

const Who = z.object({ who: z.string() });

export default createRouteRoot("/reports")({
\tget: createRoute({
\t\tresponses: { ok: { status: 200, schema: Who } },
\t\trun: ({ ctx }) => {
\t\t\tconst scheme: "session" | "userToken" = ctx.auth.scheme;
\t\t\treturn { type: "ok", data: { who: \`\${ctx.badge}:\${scheme}\` } };
\t\t},
\t}),
\tpost: createRoute({
\t\tmiddleware: [requireAuth({ schemes: ["session"] })],
\t\tresponses: { created: { status: 201, schema: Who } },
\t\trun: ({ ctx }) => {
\t\t\tconst scheme: "session" = ctx.auth.scheme;
\t\t\treturn { type: "created", data: { who: \`\${scheme}:\${ctx.auth.principal.id}\` } };
\t\t},
\t}),
});
`,
	"src/routes/(staff)/audit/route.ts": `import { createRoute, createRouteRoot, requireAuth } from "@routa-ts/core";
import { z } from "zod";

export default createRouteRoot("/audit")({
\tmiddleware: [requireAuth({ schemes: ["userToken"] })],
\tget: createRoute({
\t\tresponses: { ok: { status: 200, schema: z.object({ who: z.string() }) } },
\t\trun: ({ ctx }) => {
\t\t\tconst scheme: "userToken" = ctx.auth.scheme;
\t\t\treturn { type: "ok", data: { who: \`\${scheme}:\${ctx.auth.principal.id}\` } };
\t\t},
\t}),
});
`,
	"src/routes/(staff)/tenants/$tenantId/middleware.ts": `export { sessionOnly as tenantMember } from "../../../../guards.js";
`,
	"src/routes/(staff)/tenants/$tenantId/projects/route.ts": `import { createRoute, createRouteRoot } from "@routa-ts/core";
import { z } from "zod";

export default createRouteRoot("/tenants/:tenantId/projects")({
\tget: createRoute({
\t\tinput: { params: z.object({ tenantId: z.string() }) },
\t\tresponses: { ok: { status: 200, schema: z.object({ who: z.string() }) } },
\t\trun: ({ ctx, input }) => {
\t\t\tconst scheme: "session" = ctx.auth.scheme;
\t\t\treturn { type: "ok", data: { who: \`\${input.params.tenantId}:\${scheme}\` } };
\t\t},
\t}),
});
`,
};

describe("requireAuth in folder middleware", () => {
	it("intersects folder, route, and method requirements in types, metadata, and requests", async () => {
		const cwd = project({ "src/routa.ts": countingConfig, ...composedRoutes });

		expectPassed(await run(["check"], { cwd }));

		const { routes } = validateProject(cwd, { write: false });
		const chains = Object.fromEntries(
			routes.flatMap((route) =>
				route.methods.map((method) => [
					`${method} ${route.path}`,
					(route.methodMiddleware[method.toLowerCase()] ?? route.middleware).map((item) =>
						item.authentication
							? `${item.file} ${item.name}(${item.authentication.schemes.join(", ")})`
							: item.name,
					),
				]),
			),
		);
		const folder = "src/routes/(staff)/middleware.ts staff(userToken, session)";

		expect(chains).toEqual({
			"GET /audit": [
				"withActor",
				folder,
				"withBadge",
				"src/routes/(staff)/audit/route.ts requireAuth(userToken)",
			],
			"GET /public": ["withActor"],
			"GET /reports": ["withActor", folder, "withBadge"],
			"POST /reports": [
				"withActor",
				folder,
				"withBadge",
				"src/routes/(staff)/reports/route.ts requireAuth(session)",
			],
			"GET /tenants/:tenantId/projects": [
				"withActor",
				folder,
				"withBadge",
				"src/routes/(staff)/tenants/$tenantId/middleware.ts tenantMember(session)",
			],
		});

		const generated = readFileSync(join(cwd, ".routa/routes.gen.ts"), "utf8");
		const authOf = (path: string, method: string) =>
			new RegExp(
				`\\t${JSON.stringify(path).replaceAll("/", "\\/")}: \\{[^]*?\\t\\t${method}: \\{[^}]*?readonly "auth": ([^;]+);`,
			).exec(generated)?.[1];
		const authenticated = (schemes: string) =>
			`import("@routa-ts/core").AuthenticatedAuthContext<${schemes}, RoutaPrincipal>`;

		expect(authOf("/public", "get")).toBe("RoutaAuth");
		expect(authOf("/reports", "get")).toBe(authenticated('"session" | "userToken"'));
		expect(authOf("/reports", "post")).toBe(authenticated('"session"'));
		expect(authOf("/audit", "get")).toBe(authenticated('"userToken"'));
		expect(authOf("/tenants/:tenantId/projects", "get")).toBe(authenticated('"session"'));

		const calls: string[] = [];
		(globalThis as { routaAuthCalls?: string[] }).routaAuthCalls = calls;
		const { application } = await createProjectApplication(cwd, cwd, "dev");
		const request = async (method: string, path: string, headers: Record<string, string> = {}) => {
			const response = await application.fetch(
				new Request(`http://localhost${path}`, { method, headers }),
			);
			const body = (await response.json()) as { title?: string };
			return [
				response.status,
				response.headers.get("www-authenticate"),
				response.status === 401 ? body.title : body,
			];
		};
		const session = { cookie: "session=session-id" };
		const bearerToken = { authorization: "Bearer user-token" };
		const serviceKey = { "x-api-key": "service-key" };

		try {
			expect(await request("GET", "/public")).toEqual([200, null, { actor: "anonymous" }]);
			expect(await request("GET", "/reports")).toEqual([
				401,
				"Session, Bearer",
				"Authentication required",
			]);
			expect(await request("GET", "/reports", serviceKey)).toEqual([
				401,
				"Session, Bearer",
				"Authentication failed",
			]);
			expect(await request("GET", "/reports", session)).toEqual([
				200,
				null,
				{ who: "staff:user_2:session" },
			]);
			expect(await request("POST", "/reports", bearerToken)).toEqual([
				401,
				"Session",
				"Authentication failed",
			]);
			expect(await request("POST", "/reports", session)).toEqual([
				201,
				null,
				{ who: "session:user_2" },
			]);
			expect(await request("GET", "/audit", session)).toEqual([
				401,
				"Bearer",
				"Authentication failed",
			]);
			expect(await request("GET", "/audit", bearerToken)).toEqual([
				200,
				null,
				{ who: "userToken:user_1" },
			]);
			expect(await request("GET", "/tenants/acme/projects", bearerToken)).toEqual([
				401,
				"Session",
				"Authentication failed",
			]);
			expect(await request("GET", "/tenants/acme/projects", session)).toEqual([
				200,
				null,
				{ who: "acme:session" },
			]);
			// A credential the operation does not accept never reaches its authenticator.
			expect(calls).toEqual(["session", "session", "userToken", "session"]);
		} finally {
			await application.dispose();
			delete (globalThis as { routaAuthCalls?: string[] }).routaAuthCalls;
		}
	}, 60_000);

	it("declares the security and outcomes each inherited requirement leaves", () => {
		const document = generateOpenApi(
			project({ "src/routa.ts": countingConfig, ...composedRoutes }),
		) as Record<string, any>;
		const operations = Object.fromEntries(
			Object.entries(document.paths as Record<string, Record<string, any>>).flatMap(
				([path, methods]) =>
					Object.entries(methods).map(([method, operation]) => [
						`${method.toUpperCase()} ${path}`,
						{
							security: operation.security,
							"401": operation.responses["401"].description.match(/`(\w+)`/g) ?? [
								operation.responses["401"].description,
							],
						},
					]),
			),
		);
		const failed = [
			"Authentication failed: the request presented a credential that is malformed, unsupported, or rejected.",
		];
		const required = ["`authenticationFailed`", "`authenticationRequired`"];

		expect(document["x-routa-diagnostics"]).toBeUndefined();
		expect(operations).toEqual({
			"GET /audit": { security: [{ userToken: [] }], "401": required },
			"GET /public": {
				security: [{}, { session: [] }, { userToken: [] }, { serviceKey: [] }],
				"401": failed,
			},
			"GET /reports": { security: [{ session: [] }, { userToken: [] }], "401": required },
			"POST /reports": { security: [{ session: [] }], "401": required },
			"GET /tenants/{tenantId}/projects": { security: [{ session: [] }], "401": required },
		});
	});

	it("protects every route under a root guard", async () => {
		const cwd = project({
			"src/routa.ts": routaConfig,
			"src/routes/middleware.ts": `import { requireAuth } from "@routa-ts/core";

export const signedIn = requireAuth();
`,
			"src/routes/me/route.ts": `import { createRoute, createRouteRoot } from "@routa-ts/core";
import { z } from "zod";

export default createRouteRoot("/me")({
\tget: createRoute({
\t\tresponses: { ok: { status: 200, schema: z.object({ id: z.string() }) } },
\t\trun: ({ ctx }) => {
\t\t\tconst scheme: "userToken" = ctx.auth.scheme;
\t\t\tvoid scheme;
\t\t\treturn { type: "ok", data: { id: ctx.auth.principal.id } };
\t\t},
\t}),
});
`,
		});

		expectPassed(await run(["check"], { cwd }));
		expect((generateOpenApi(cwd) as Record<string, any>).paths["/me"].get.security).toEqual([
			{ userToken: [] },
		]);

		const { application } = await createProjectApplication(cwd, cwd, "dev");
		const me = (headers: Record<string, string> = {}) =>
			application.fetch(new Request("http://localhost/me", { headers }));

		try {
			const required = await me();
			expect(required.status).toBe(401);
			expect(required.headers.get("www-authenticate")).toBe('Bearer realm="api"');
			expect(await (await me({ authorization: "Bearer user-token" })).json()).toEqual({
				id: "user_1",
			});
		} finally {
			await application.dispose();
		}
	}, 30_000);

	it("reads guards bound to a const, imported, or called through a core namespace", async () => {
		const signedInRoute = (
			path: string,
			middleware = "",
		) => `import { createRoute, createRouteRoot } from "@routa-ts/core";
import * as core from "@routa-ts/core";
import { z } from "zod";

void core;

export default createRouteRoot("${path}")({
\tget: createRoute({${middleware}
\t\tresponses: { ok: { status: 200, schema: z.object({ id: z.string() }) } },
\t\trun: ({ ctx }) => {
\t\t\tconst scheme: "userToken" = ctx.auth.scheme;
\t\t\tvoid scheme;
\t\t\treturn { type: "ok", data: { id: ctx.auth.principal.id } };
\t\t},
\t}),
});
`;
		const cwd = project({
			"src/routa.ts": `import * as core from "@routa-ts/core";
import { z } from "zod";

export default core.createRouta({
\tauthentication: {
\t\tprincipal: z.object({ id: z.string(), type: z.literal("user") }),
\t\tschemes: {
\t\t\tuserToken: core.bearer({
\t\t\t\tauthenticate: (token) =>
\t\t\t\t\ttoken === "user-token"
\t\t\t\t\t\t? { type: "authenticated", principal: { id: "user_1", type: "user" } }
\t\t\t\t\t\t: { type: "rejected" },
\t\t\t}),
\t\t},
\t},
});
`,
			"src/guards.ts": `import { requireAuth } from "@routa-ts/core";

const base = requireAuth({ schemes: ["userToken"] });

export const member = base;
`,
			"src/routes/(aliased)/middleware.ts": `import { requireAuth } from "@routa-ts/core";

const guard = requireAuth();

export const signedIn = guard;
`,
			"src/routes/(aliased)/aliased/route.ts": signedInRoute("/aliased"),
			"src/routes/(imported)/middleware.ts": `import { member } from "../../guards.js";

export const signedIn = member;
`,
			"src/routes/(imported)/imported/route.ts": signedInRoute("/imported"),
			"src/routes/(namespaced)/middleware.ts": `import * as core from "@routa-ts/core";

export const signedIn = core.requireAuth({ schemes: ["userToken"] });
`,
			"src/routes/(namespaced)/namespaced/route.ts": signedInRoute("/namespaced"),
			"src/routes/inline/route.ts": signedInRoute(
				"/inline",
				"\n\t\tmiddleware: [core.requireAuth()],",
			),
		});

		expectPassed(await run(["check"], { cwd }));

		const { routes } = validateProject(cwd, { write: false });
		expect(
			Object.fromEntries(
				routes.map((route) => [
					route.path,
					route.methodMiddleware.get!.map(
						(item) => `${item.file} ${item.name}(${item.authentication?.schemes.join(", ")})`,
					),
				]),
			),
		).toEqual({
			"/aliased": ["src/routes/(aliased)/middleware.ts signedIn(userToken)"],
			"/imported": ["src/routes/(imported)/middleware.ts signedIn(userToken)"],
			"/inline": ["src/routes/inline/route.ts requireAuth(userToken)"],
			"/namespaced": ["src/routes/(namespaced)/middleware.ts signedIn(userToken)"],
		});

		const document = generateOpenApi(cwd) as Record<string, any>;
		expect(Object.keys(document.components.securitySchemes)).toEqual(["userToken"]);
		expect(
			Object.fromEntries(
				Object.entries(document.paths as Record<string, any>).map(([path, item]) => [
					path,
					item.get.security,
				]),
			),
		).toEqual({
			"/aliased": [{ userToken: [] }],
			"/imported": [{ userToken: [] }],
			"/inline": [{ userToken: [] }],
			"/namespaced": [{ userToken: [] }],
		});

		const { application } = await createProjectApplication(cwd, cwd, "dev");
		const get = async (path: string, headers: Record<string, string> = {}) => {
			const response = await application.fetch(new Request(`http://localhost${path}`, { headers }));
			return [response.status, await response.json()];
		};

		try {
			for (const path of ["/aliased", "/imported", "/inline", "/namespaced"]) {
				expect(await get(path)).toEqual([401, expect.objectContaining({ status: 401 })]);
				expect(await get(path, { authorization: "Bearer user-token" })).toEqual([
					200,
					{ id: "user_1" },
				]);
			}
		} finally {
			await application.dispose();
		}
	}, 60_000);

	it("refuses to start when the generated metadata misses a folder guard", async () => {
		const folder = "src/routes/(private)/middleware.ts";
		const cwd = project({
			"src/routa.ts": routaConfig,
			[folder]: "export {};\n",
			"src/routes/(private)/me/route.ts": meRoute,
		});

		expectPassed(await run(["generate"], { cwd }));
		expect(readFileSync(join(cwd, ".routa/routes.gen.ts"), "utf8")).toContain(
			`"middlewareFiles": [\n\t\t\t"${folder}"\n\t\t]`,
		);
		// A guard written after generation, which the metadata cannot list. Two factory levels
		// stand in for any form a generator might not read.
		writeFileSync(
			join(cwd, folder),
			`import { requireAuth } from "@routa-ts/core";

const inner = () => requireAuth();
const outer = () => inner();

export const signedIn = outer();
`,
		);
		const message = `${folder} exports signedIn, a requireAuth() guard .routa/routes.gen.ts does not list, so it would not run and the routes below would be public. Write it as export const signedIn = requireAuth({ ... }), or re-export a const declared that way, then run routa generate.`;

		await expect(createProjectApplication(cwd, cwd, "dev")).rejects.toThrow(message);

		const { createTestApp } = (await import(
			pathToFileURL(join(cwd, ".routa/testing.gen.ts")).href
		)) as { createTestApp: () => Promise<unknown> };
		await expect(createTestApp()).rejects.toThrow(message);
	}, 30_000);
});

describe("folder requirement diagnostics", () => {
	const config = configWith(
		'{ principal: Principal, schemes: { a: apiKey({ header: "x-a", authenticate: reject }), b: sessionCookie({ cookie: "b", authenticate: reject }) } }',
	).replace(
		'import { bearer, createRouta } from "@routa-ts/core";',
		'import { apiKey, createRouta, sessionCookie } from "@routa-ts/core";',
	);
	const folder = "src/routes/(private)/middleware.ts";
	const guarded = (exports: string, files: Record<string, string> = {}) => ({
		"src/routa.ts": config,
		[folder]: `import { requireAuth } from "@routa-ts/core";\n\n${exports}\n`,
		"src/routes/(private)/projects/route.ts": routeWith("", "createRoute, createRouteRoot"),
		...files,
	});

	it("checks a folder guard's schemes against the configuration", () => {
		const cases: Array<[string, string, string]> = [
			[
				'export const signedIn = requireAuth({ schemes: ["c"] });',
				"ROUTA_AUTH_SCHEME_UNKNOWN",
				`requireAuth() in ${folder} allows scheme "c", which src/routa.ts does not declare.`,
			],
			[
				"export const signedIn = requireAuth({ schemes: [] });",
				"ROUTA_AUTH_REQUIREMENT_EMPTY",
				`requireAuth() in ${folder} allows no schemes, so no request could pass it.`,
			],
		];

		for (const [exports, code, message] of cases) {
			expect(diagnostics(guarded(exports))).toEqual([{ code, message }]);
		}

		expect(
			diagnostics({
				...guarded("export const signedIn = requireAuth();"),
				"src/routa.ts": plainConfig,
			}),
		).toEqual([
			{
				code: "ROUTA_AUTH_NOT_CONFIGURED",
				message: `requireAuth() in ${folder} needs authentication, but src/routa.ts configures none.`,
			},
		]);
	});

	it("reports a re-exported guard where its call is written, once", () => {
		const guards = `import { requireAuth } from "@routa-ts/core";

export const memberOnly = requireAuth({ schemes: ["c"] });
`;

		expect(
			diagnostics({
				"src/routa.ts": config,
				"src/guards.ts": guards,
				"src/routes/middleware.ts": 'export { memberOnly } from "../guards.js";\n',
				"src/routes/(private)/middleware.ts": 'export { memberOnly } from "../../guards.js";\n',
				"src/routes/(private)/projects/route.ts": routeWith("", "createRoute, createRouteRoot"),
			}),
		).toEqual([
			{
				code: "ROUTA_AUTH_SCHEME_UNKNOWN",
				message:
					'requireAuth() in src/guards.ts allows scheme "c", which src/routa.ts does not declare.',
			},
		]);
	});

	it("reports folder guards it cannot read, which would not run", () => {
		const unread = (name: string) => ({
			code: "ROUTA_AUTH_REQUIREMENT_UNRESOLVED",
			message: `${folder} exports ${name}, which builds a requireAuth() guard routa check cannot read, so the guard would not run.`,
		});
		const options = {
			code: "ROUTA_AUTH_REQUIREMENT_UNRESOLVED",
			message: `requireAuth() in ${folder} declares options that cannot be statically read.`,
		};
		const cases: Array<[string, Record<string, string>, Array<{ code: string; message: string }>]> =
			[
				[
					'const allowed = ["a"] as const;\nexport const signedIn = requireAuth({ schemes: allowed });',
					{},
					[options],
				],
				[
					'const options = { schemes: ["a"] as const };\nexport const signedIn = requireAuth({ ...options });',
					{},
					[options],
				],
				[
					'declare const strict: boolean;\nexport const signedIn = strict ? requireAuth({ schemes: ["a"] }) : requireAuth();',
					{},
					[unread("signedIn")],
				],
				[
					'const guardFor = (scheme: "a" | "b") => requireAuth({ schemes: [scheme] });\nexport const signedIn = guardFor("a");',
					{},
					[unread("signedIn")],
				],
				[
					'import { guardFor } from "../../guards.js";\n\nexport const signedIn = guardFor("a");',
					{
						"src/guards.ts": `import { requireAuth } from "@routa-ts/core";

export function guardFor(scheme: "a" | "b") {
\treturn requireAuth({ schemes: [scheme] });
}
`,
					},
					[unread("signedIn")],
				],
			];

		for (const [exports, files, expected] of cases) {
			expect(diagnostics(guarded(exports, files))).toEqual(expected);
		}
	});

	it("reports guards built through factories, aliases, destructuring, and let bindings at any depth", () => {
		const builds = {
			code: "ROUTA_AUTH_REQUIREMENT_UNRESOLVED",
			message: `${folder} exports signedIn, which builds a requireAuth() guard routa check cannot read, so the guard would not run.`,
		};
		const cases: Array<[string, Record<string, string>]> = [
			[
				"const inner = () => requireAuth();\nconst outer = () => inner();\nexport const signedIn = outer();",
				{},
			],
			[
				'import { guardFor } from "../../guards/index.js";\n\nexport const signedIn = guardFor();',
				{
					"src/guards/index.ts": 'export { guardFor } from "./factory.js";\n',
					"src/guards/factory.ts": `import { requireAuth } from "@routa-ts/core";

const inner = () => requireAuth();

export function guardFor() {
\treturn inner();
}
`,
				},
			],
			[
				"const guardFor = () => requireAuth();\nconst guard = guardFor();\nexport const signedIn = guard;",
				{},
			],
			["export const { signedIn } = { signedIn: requireAuth() };", {}],
			["const { guard } = { guard: requireAuth() };\nexport const signedIn = guard;", {}],
			// Code can reassign a let or var binding after Routa reads it.
			["export let signedIn = requireAuth();", {}],
			["let guard = requireAuth();\nexport const signedIn = guard;", {}],
			["var guard = requireAuth();\nexport { guard as signedIn };", {}],
			[
				'export { signedIn } from "../../guards.js";',
				{
					"src/guards.ts":
						'import { requireAuth } from "@routa-ts/core";\n\nexport let signedIn = requireAuth();\n',
				},
			],
		];

		for (const [exports, files] of cases) {
			expect(diagnostics(guarded(exports, files))).toEqual([builds]);
		}
	});

	it("leaves exported functions that build guards alone", () => {
		expect(
			diagnostics(
				guarded(`export const guardFor = () => requireAuth();
export const strictGuardFor = function () {
\treturn requireAuth({ schemes: ["a"] });
};
const memberGuardFor = () => requireAuth();
export { memberGuardFor as aliasedGuardFor };
export const signedIn = guardFor();`),
			),
		).toEqual([
			{
				code: "ROUTA_AUTH_REQUIREMENT_UNRESOLVED",
				message: `${folder} exports signedIn, which builds a requireAuth() guard routa check cannot read, so the guard would not run.`,
			},
		]);
	});

	it("does not read a property name that matches a guard as a reference to it", () => {
		expect(
			diagnostics(
				guarded(`export const signedIn = requireAuth({ schemes: ["a"] });
export const meta = { signedIn: true, label: "staff" };
export const label = meta.signedIn ? "guarded" : "open";`),
			),
		).toEqual([]);
	});

	it("reads re-exports whose module declares a type of the same name first", () => {
		const validation = validateProject(
			project(
				guarded("", {
					[folder]: `export { signedIn } from "../../guards.js";
export { audit } from "../../audit.js";
`,
					"src/guards.ts": `import { requireAuth } from "@routa-ts/core";

export type signedIn = typeof signedIn;
export const signedIn = requireAuth({ schemes: ["a"] });
`,
					"src/audit.ts": `import { createMiddleware } from "@routa-ts/core";

export interface audit {
\treadonly name: "audit";
}
export const audit = createMiddleware({ run: ({ next }) => next() });
`,
				}),
			),
			{ write: false },
		);

		expect(validation.diagnostics).toEqual([]);
		expect(validation.routes[0]!.middleware).toEqual([
			expect.objectContaining({
				file: folder,
				name: "signedIn",
				authentication: { schemes: ["a"] },
			}),
			expect.objectContaining({ file: folder, name: "audit" }),
		]);
	});

	it("reads requireAuth imported under the name createMiddleware as a guard", () => {
		const validation = validateProject(
			project(
				guarded(`import { requireAuth as createMiddleware } from "@routa-ts/core";

export const signedIn = createMiddleware({ schemes: ["a"] });`),
			),
			{ write: false },
		);

		expect(validation.diagnostics).toEqual([]);
		expect(validation.routes[0]!.middleware).toEqual([
			expect.objectContaining({
				file: folder,
				name: "signedIn",
				authentication: { schemes: ["a"] },
			}),
		]);
	});

	it("leaves folder exports that cannot be guards alone", () => {
		expect(
			diagnostics(
				guarded(
					`import { createMiddleware } from "@routa-ts/core";

export const role = "admin";
export const limits = { perMinute: 60 };
export const roles = ["admin"];
export const format = (value: string) => value.trim();
export function helper() {
\treturn 1;
}
export type Role = "admin";
const withNothing = createMiddleware({ run: ({ next }) => next() });
export const withAlias = withNothing;
export { helperFrom, Shape } from "../../helpers.js";`,
					{
						"src/helpers.ts":
							"export type Shape = { id: string };\n\nexport function helperFrom() {\n\treturn 1;\n}\n",
					},
				),
			),
		).toEqual([]);
	});

	it("reads credential schemes declared through a core namespace", () => {
		const cwd = project({
			"src/routa.ts": `import * as core from "@routa-ts/core";
import { z } from "zod";

const reject = () => ({ type: "rejected" }) as const;

export default core.createRouta({
\tauthentication: {
\t\tprincipal: z.object({ id: z.string(), type: z.literal("user") }),
\t\tschemes: {
\t\t\tserviceKey: core.apiKey({ header: "x-api-key", authenticate: reject }),
\t\t\tsession: core.sessionCookie({ cookie: "sid", authenticate: reject }),
\t\t},
\t},
});
`,
			"src/routes/(private)/projects/route.ts": routeWith("", "createRoute, createRouteRoot"),
		});

		expect(validateProject(cwd, { write: false }).diagnostics).toEqual([]);
		expect((generateOpenApi(cwd) as Record<string, any>).components.securitySchemes).toEqual({
			serviceKey: { type: "apiKey", in: "header", name: "x-api-key" },
			session: { type: "apiKey", in: "cookie", name: "sid" },
		});
	});

	it("keeps an application middleware named requireAuth ordinary middleware", () => {
		const cwd = project({
			"src/routa.ts": config,
			"src/middleware/auth.ts": `import { createMiddleware } from "@routa-ts/core";

export const requireAuth = createMiddleware({ run: ({ next }) => next() });
`,
			[folder]: 'export { requireAuth } from "../../middleware/auth.js";\n',
			"src/routes/(private)/projects/route.ts": routeWith("", "createRoute, createRouteRoot"),
		});
		const validation = validateProject(cwd, { write: false });

		expect(validation.diagnostics).toEqual([]);
		expect(validation.routes[0]!.middleware).toEqual([
			expect.objectContaining({ file: folder, name: "requireAuth" }),
		]);
		expect(validation.routes[0]!.middleware[0]!.authentication).toBeUndefined();
	});

	it("reports folder, route, and method requirements that allow no scheme in common", () => {
		expect(
			diagnostics(
				guarded('export const signedIn = requireAuth({ schemes: ["a"] });', {
					"src/routes/(private)/projects/route.ts": routeWith('requireAuth({ schemes: ["b"] })'),
				}),
			),
		).toEqual([
			{
				code: "ROUTA_AUTH_REQUIREMENT_EMPTY",
				message: `requireAuth() guards on GET /projects allow no scheme in common, so no request could pass them: ${folder} allows "a"; src/routes/(private)/projects/route.ts allows "b".`,
			},
		]);
	});

	it("warns when a guard lists schemes the requirement it follows excludes", () => {
		const validation = validateProject(
			project(
				guarded('export const signedIn = requireAuth({ schemes: ["a"] });', {
					"src/routes/(private)/projects/route.ts": routeWith(
						'requireAuth({ schemes: ["a", "b"] })',
					),
				}),
			),
			{ write: false },
		);

		expect(validation.diagnostics).toEqual([]);
		expect(validation.warnings.map(({ code, message, file }) => ({ code, message, file }))).toEqual(
			[
				{
					code: "ROUTA_AUTH_REQUIREMENT_WIDENED",
					message: `requireAuth() in src/routes/(private)/projects/route.ts allows "b", which the requireAuth() in ${folder} it follows does not. Requirements only narrow, so it accepts "a".`,
					file: "src/routes/(private)/projects/route.ts",
				},
			],
		);
	});
});

const customConfig = (
	schemes = "",
	options = "",
) => `import { bearer, createRouta, custom } from "@routa-ts/core";
import { z } from "zod";

const Principal = z.discriminatedUnion("type", [
\tz.object({ type: z.literal("user"), id: z.string() }),
\tz.object({ type: z.literal("service"), id: z.string() }),
]);

/** Decodes Basic credentials, or reports them malformed. */
function decodeBasic(value: string) {
\tconst decoded = atob(value);
\tconst index = decoded.indexOf(":");
\treturn index === -1
\t\t? ({ type: "malformed" } as const)
\t\t: ({ type: "credential", credential: { user: decoded.slice(0, index), password: decoded.slice(index + 1) } } as const);
}

export default createRouta({
\tauthentication: {
\t\tprincipal: Principal,
\t\tschemes: {
\t\t\tuserToken: bearer({
\t\t\t\tauthenticate: (token) =>
\t\t\t\t\ttoken === "user-token" ? { type: "authenticated", principal: { type: "user", id: "user_1" } } : { type: "rejected" },
\t\t\t}),
\t\t\tbasicUser: custom({
\t\t\t\ttransport: { header: "authorization", scheme: "Basic" },
\t\t\t\tchallenge: { scheme: "Basic", realm: "api" },
\t\t\t\topenapi: { type: "http", scheme: "basic", description: "HTTP Basic with an account password." },
\t\t\t\textract: (value) => decodeBasic(value),
\t\t\t\tauthenticate: (credential) =>
\t\t\t\t\tcredential.user === "ada" && credential.password === "secret"
\t\t\t\t\t\t? { type: "authenticated", principal: { type: "user", id: "user_ada" } }
\t\t\t\t\t\t: { type: "rejected" },
\t\t\t}),${schemes}
\t\t},${options}
\t},
});
`;

const accountRoute = `import { createRoute, createRouteRoot, requireAuth } from "@routa-ts/core";
import { z } from "zod";

// Type assertions only; never called.
export const typeChecks = () => {
\trequireAuth({ schemes: ["basicUser"] });
\t// @ts-expect-error Only schemes src/routa.ts declares.
\trequireAuth({ schemes: ["basicUsr"] });
};

export default createRouteRoot("/account")({
\tget: createRoute({
\t\tresponses: { ok: { status: 200, schema: z.object({ who: z.string() }) } },
\t\trun: ({ ctx }) => {
\t\t\tif (ctx.auth.status === "anonymous") {
\t\t\t\treturn { type: "ok", data: { who: "anonymous" } };
\t\t\t}

\t\t\tconst scheme: "userToken" | "basicUser" = ctx.auth.scheme;
\t\t\t// @ts-expect-error A public operation accepts either scheme.
\t\t\tconst onlyBasic: "basicUser" = ctx.auth.scheme;
\t\t\tvoid onlyBasic;

\t\t\tif (ctx.auth.scheme === "basicUser") {
\t\t\t\tconst type: "user" | "service" = ctx.auth.principal.type;
\t\t\t\t// @ts-expect-error The principal is the user | service union.
\t\t\t\tconst onlyUser: "user" = ctx.auth.principal.type;
\t\t\t\tvoid [type, onlyUser];
\t\t\t}

\t\t\treturn { type: "ok", data: { who: \`\${scheme}:\${ctx.auth.principal.id}\` } };
\t\t},
\t}),
\tput: createRoute({
\t\tmiddleware: [requireAuth({ schemes: ["basicUser"] })],
\t\tresponses: { ok: { status: 200, schema: z.object({ who: z.string() }) } },
\t\trun: ({ ctx }) => {
\t\t\tconst scheme: "basicUser" = ctx.auth.scheme;
\t\t\t// @ts-expect-error Behind requireAuth({ schemes: ["basicUser"] }), the scheme is basicUser.
\t\t\tconst other: "userToken" = ctx.auth.scheme;
\t\t\tvoid other;
\t\t\treturn { type: "ok", data: { who: \`\${scheme}:\${ctx.auth.principal.id}\` } };
\t\t},
\t}),
});
`;

const basic = (user: string, password: string) =>
	`Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;

describe("custom credential schemes in a project", () => {
	it("checks, types, and serves a custom scheme beside Bearer", async () => {
		const cwd = project({
			"src/routa.ts": customConfig("", '\n\t\tpriority: ["basicUser", "userToken"],'),
			"src/routes/account/route.ts": accountRoute,
		});

		expectPassed(await run(["check"], { cwd }));
		expect(readFileSync(join(cwd, ".routa/routes.gen.ts"), "utf8")).toContain(
			'export const routaAuthenticationSchemes = [\n\t"basicUser",\n\t"userToken"\n] as const;',
		);

		const { application } = await createProjectApplication(cwd, cwd, "dev");
		const request = async (method: string, headers: Record<string, string>) => {
			const response = await application.fetch(
				new Request("http://localhost/account", { method, headers }),
			);
			return [response.status, response.headers.get("www-authenticate"), await response.json()];
		};
		const failed = expect.objectContaining({ title: "Authentication failed" });

		expect(await request("GET", { authorization: basic("ada", "secret") })).toEqual([
			200,
			null,
			{ who: "basicUser:user_ada" },
		]);
		expect(await request("GET", { authorization: "Bearer user-token" })).toEqual([
			200,
			null,
			{ who: "userToken:user_1" },
		]);
		expect(await request("GET", { authorization: basic("ada", "wrong") })).toEqual([
			401,
			'Basic realm="api"',
			failed,
		]);
		expect(await request("GET", { authorization: "Basic bm8tY29sb24=" })).toEqual([
			401,
			'Basic realm="api"',
			failed,
		]);
		expect(await request("GET", { authorization: "Digest abc" })).toEqual([
			401,
			'Basic realm="api", Bearer',
			failed,
		]);
		expect(await request("PUT", { authorization: "Bearer user-token" })).toEqual([
			401,
			'Basic realm="api"',
			failed,
		]);
		expect(await request("PUT", {})).toEqual([
			401,
			'Basic realm="api"',
			expect.objectContaining({ title: "Authentication required" }),
		]);
		expect(await request("PUT", { authorization: basic("ada", "secret") })).toEqual([
			200,
			null,
			{ who: "basicUser:user_ada" },
		]);
		await application.dispose();
	}, 30_000);

	it("generates OpenAPI security from each custom scheme's public metadata", () => {
		const document = generateOpenApi(
			project({
				"src/routa.ts": customConfig(
					`
\t\t\tclientCert: custom({
\t\t\t\ttransport: { header: "x-client-cert" },
\t\t\t\topenapi: { type: "mutualTLS", description: "A client certificate the TLS proxy verified." },
\t\t\t\tauthenticate: () => ({ type: "rejected" }),
\t\t\t}),
\t\t\tdevice: custom({
\t\t\t\ttransport: { cookie: "device" },
\t\t\t\topenapi: { type: "apiKey", in: "cookie", name: "device" },
\t\t\t\tauthenticate: () => ({ type: "rejected" }),
\t\t\t}),`,
				),
				"src/routes/account/route.ts": accountRoute,
			}),
		) as Record<string, any>;
		const operations = document.paths["/account"];

		expect(document["x-routa-diagnostics"]).toBeUndefined();
		expect(document.components.securitySchemes).toEqual({
			userToken: { type: "http", scheme: "bearer" },
			basicUser: {
				type: "http",
				scheme: "basic",
				description: "HTTP Basic with an account password.",
			},
			clientCert: {
				type: "mutualTLS",
				description: "A client certificate the TLS proxy verified.",
			},
			device: { type: "apiKey", in: "cookie", name: "device" },
		});
		expect(operations.get.security).toEqual([
			{},
			{ userToken: [] },
			{ basicUser: [] },
			{ clientCert: [] },
			{ device: [] },
		]);
		expect(operations.put.security).toEqual([{ basicUser: [] }]);
		expect(Object.keys(operations.put.responses)).toEqual(["200", "401"]);
	});

	it("reads a custom scheme's transport, challenge, and OpenAPI metadata as contract facts", () => {
		const validation = validateProject(
			project({
				"src/routa.ts": customConfig(
					`
\t\t\tclientCert: custom({
\t\t\t\ttransport: { header: "X-Client-Cert" },
\t\t\t\topenapi: { type: "mutualTLS" },
\t\t\t\tauthenticate: () => ({ type: "rejected" }),
\t\t\t}),`,
				),
			}),
			{ write: false },
		);

		expect(validation.diagnostics).toEqual([]);
		expect(validation.authentication?.schemes.slice(1)).toEqual([
			{
				name: "basicUser",
				kind: "custom",
				transport: { header: "authorization", scheme: "Basic" },
				challengeScheme: "Basic",
				realm: "api",
				openapi: {
					type: "http",
					scheme: "basic",
					description: "HTTP Basic with an account password.",
				},
			},
			{
				name: "clientCert",
				kind: "custom",
				transport: { header: "X-Client-Cert" },
				openapi: { type: "mutualTLS" },
			},
		]);
	});
});

describe("custom credential scheme diagnostics", () => {
	const config = (schemes: string) =>
		configWith(`{ principal: Principal, schemes: { ${schemes} } }`).replace(
			'import { bearer, createRouta } from "@routa-ts/core";',
			'import { apiKey, bearer, createRouta, custom, sessionCookie } from "@routa-ts/core";',
		);
	const scheme = (options: string) => `custom({ ${options}, authenticate: reject })`;
	const header = (name: string, authScheme?: string) =>
		authScheme === undefined
			? scheme(
					`transport: { header: "${name}" }, openapi: { type: "apiKey", in: "header", name: "${name}" }`,
				)
			: scheme(
					`transport: { header: "${name}", scheme: "${authScheme}" }, openapi: { type: "http", scheme: "${authScheme}" }`,
				);
	const cookie = (name: string) =>
		scheme(
			`transport: { cookie: "${name}" }, openapi: { type: "apiKey", in: "cookie", name: "${name}" }`,
		);
	const token = "bearer({ authenticate: reject })";
	const valid = 'transport: { header: "x-signed" }, openapi: { type: "mutualTLS" }';

	it("reads extract and authenticate methods, but not a transport or openapi method", () => {
		const methods = `${valid}, extract(value) { return { type: "credential", credential: value }; }, authenticate(credential) { return credential === "c" ? { type: "authenticated", principal: { id: credential, type: "user" } } : { type: "rejected" }; }`;
		const validation = validateProject(
			project({ "src/routa.ts": config(`a: custom({ ${methods} })`) }),
			{
				write: false,
			},
		);

		expect(validation.diagnostics).toEqual([]);
		expect(validation.authentication?.schemes).toEqual([
			{
				name: "a",
				kind: "custom",
				transport: { header: "x-signed" },
				openapi: { type: "mutualTLS" },
			},
		]);

		for (const [options, message] of [
			[
				'transport() { return { header: "x-signed" }; }, openapi: { type: "mutualTLS" }',
				'Authentication scheme "a" declares a transport that is not a literal { header }, { header, scheme }, or { cookie } object.',
			],
			[
				'transport: { header: "x-signed" }, openapi() { return { type: "mutualTLS" }; }',
				'Authentication scheme "a" declares openapi metadata that is not a literal object.',
			],
		]) {
			expect(diagnostics({ "src/routa.ts": config(`a: ${scheme(options!)}`) }), options).toEqual([
				{ code: "ROUTA_AUTH_CONFIG_UNRESOLVED", message },
			]);
		}
	});

	it("reports transports another scheme already reads", () => {
		const cases: Array<[string, string]> = [
			[
				`a: ${token}, b: ${header("Authorization", "bearer")}`,
				'Authentication schemes "a" and "b" both read the Authorization Bearer credential.',
			],
			[
				`a: ${token}, b: ${header("authorization")}`,
				'Authentication schemes "a" and "b" both read the Authorization Bearer credential.',
			],
			[
				`a: ${header("authorization", "Basic")}, b: ${header("authorization", "BASIC")}`,
				'Authentication schemes "a" and "b" both read the Authorization Basic credential.',
			],
			[
				`a: ${header("Authorization")}, b: ${header("authorization", "Basic")}`,
				'Authentication schemes "a" and "b" both read the Authorization Basic credential.',
			],
			[
				`a: ${header("X-Client-Cert")}, b: ${header("x-client-cert")}`,
				'Authentication schemes "a" and "b" both read the x-client-cert header.',
			],
			[
				`a: apiKey({ header: "x-api-key", authenticate: reject }), b: ${header("X-Api-Key")}`,
				'Authentication schemes "a" and "b" both read the x-api-key header.',
			],
			[
				`a: sessionCookie({ cookie: "sid", authenticate: reject }), b: ${cookie("sid")}`,
				'Authentication schemes "a" and "b" both read the "sid" cookie.',
			],
			[
				`a: ${cookie("sid")}, b: ${header("cookie")}`,
				'Authentication schemes "a" and "b" both read the "sid" cookie.',
			],
		];

		for (const [schemes, message] of cases) {
			expect(diagnostics({ "src/routa.ts": config(schemes) }), schemes).toEqual([
				{ code: "ROUTA_AUTH_TRANSPORT_OVERLAP", message },
			]);
		}

		expect(
			diagnostics({
				"src/routa.ts": config(
					`a: ${token}, b: ${header("authorization", "Basic")}, c: ${header("x-a")}, d: ${cookie("sid")}`,
				),
			}),
		).toEqual([]);
	});

	it("reports transports, challenges, and OpenAPI metadata it cannot read or accept", () => {
		const at = 'Authentication scheme "a"';
		const cases: Array<[string, string, string]> = [
			[
				'openapi: { type: "mutualTLS" }',
				"ROUTA_AUTH_CONFIG_INVALID",
				`${at} declares no transport.`,
			],
			[
				`transport: signed, openapi: { type: "mutualTLS" }`,
				"ROUTA_AUTH_CONFIG_UNRESOLVED",
				`${at} declares a transport that is not a literal { header }, { header, scheme }, or { cookie } object.`,
			],
			[
				`transport: { header: "x-a", cookie: "a" }, openapi: { type: "mutualTLS" }`,
				"ROUTA_AUTH_CONFIG_INVALID",
				`${at} declares a transport with both header and cookie. Read one header or one cookie.`,
			],
			[
				`transport: { header: name }, openapi: { type: "mutualTLS" }`,
				"ROUTA_AUTH_CONFIG_UNRESOLVED",
				`${at} declares a transport header that is not a string literal.`,
			],
			[
				`transport: { header: "x a" }, openapi: { type: "mutualTLS" }`,
				"ROUTA_AUTH_CONFIG_INVALID",
				`${at} declares transport header "x a", which is not an HTTP header name.`,
			],
			[
				`transport: { cookie: "a;b" }, openapi: { type: "apiKey", in: "cookie", name: "a;b" }`,
				"ROUTA_AUTH_CONFIG_INVALID",
				`${at} declares transport cookie "a;b", which is not a cookie name.`,
			],
			[
				`transport: { header: "x-a", scheme: "Basic" }, openapi: { type: "mutualTLS" }`,
				"ROUTA_AUTH_CONFIG_INVALID",
				`${at} declares transport scheme "Basic" on the x-a header. A transport scheme applies only to the Authorization header.`,
			],
			[
				`transport: { header: "authorization", scheme: "Ba sic" }, openapi: { type: "http", scheme: "basic" }`,
				"ROUTA_AUTH_CONFIG_INVALID",
				`${at} declares transport scheme "Ba sic", which is not an HTTP auth-scheme.`,
			],
			[
				`${valid}, challenge: { scheme: "Ba sic" }`,
				"ROUTA_AUTH_CHALLENGE_INVALID",
				`${at} declares a challenge scheme that is not an HTTP auth-scheme.`,
			],
			[
				`${valid}, challenge: { scheme: authScheme }`,
				"ROUTA_AUTH_CHALLENGE_INVALID",
				`${at} declares a challenge scheme that is not a string literal.`,
			],
			[
				`${valid}, challenge: { error: "invalid" }`,
				"ROUTA_AUTH_CHALLENGE_INVALID",
				`${at} declares challenge "error". A custom challenge override accepts only scheme and realm.`,
			],
			[
				'transport: { header: "x-signed" }',
				"ROUTA_AUTH_CONFIG_INVALID",
				`${at} declares no openapi metadata.`,
			],
			[
				'transport: { header: "x-signed" }, openapi: security',
				"ROUTA_AUTH_CONFIG_UNRESOLVED",
				`${at} declares openapi metadata that is not a literal object.`,
			],
			[
				'transport: { header: "x-signed" }, openapi: { type: "apiKey", in: "header", name: headerName }',
				"ROUTA_AUTH_CONFIG_UNRESOLVED",
				`${at} declares openapi name that is not a string literal.`,
			],
			[
				'transport: { header: "x-signed" }, openapi: { type: "oauth2" }',
				"ROUTA_AUTH_CONFIG_INVALID",
				`${at} declares openapi type "oauth2". Use "http", "apiKey", or "mutualTLS".`,
			],
			[
				'transport: { header: "x-signed" }, openapi: { type: "http", scheme: "basic" }',
				"ROUTA_AUTH_CONFIG_INVALID",
				`${at} declares openapi { type: "http" }, which needs an { header: "authorization", scheme } transport whose scheme is "basic".`,
			],
			[
				'transport: { header: "authorization", scheme: "Basic" }, openapi: { type: "http", scheme: "basic", bearerFormat: "JWT" }',
				"ROUTA_AUTH_CONFIG_INVALID",
				`${at} declares openapi bearerFormat, which applies only to scheme "bearer".`,
			],
			[
				'transport: { header: "authorization", scheme: "Basic" }, openapi: { type: "apiKey", in: "header", name: "authorization" }',
				"ROUTA_AUTH_CONFIG_INVALID",
				`${at} declares openapi { type: "apiKey" }, which cannot describe one Authorization auth-scheme. Use { type: "http", scheme: "Basic" }.`,
			],
			[
				'transport: { header: "x-signed" }, openapi: { type: "apiKey", in: "header", name: "x-other" }',
				"ROUTA_AUTH_CONFIG_INVALID",
				`${at} declares openapi { type: "apiKey" }, which must name the transport: in: "header", name: "x-signed".`,
			],
			[
				'transport: { cookie: "sid" }, openapi: { type: "mutualTLS" }',
				"ROUTA_AUTH_CONFIG_INVALID",
				`${at} declares openapi { type: "mutualTLS" }, which needs a header transport other than Authorization, such as a trusted proxy's client-certificate header.`,
			],
			[
				'transport: { header: "x-signed" }, openapi: { type: "mutualTLS", scopes: {} }',
				"ROUTA_AUTH_CONFIG_INVALID",
				`${at} declares openapi "scopes", which { type: "mutualTLS" } does not accept.`,
			],
		];

		for (const [options, code, message] of cases) {
			expect(
				diagnostics({
					"src/routa.ts": config(`a: ${scheme(options)}`).replace(
						"const reject",
						'declare const signed: { header: string };\ndeclare const name: string;\ndeclare const authScheme: string;\ndeclare const security: { type: "mutualTLS" };\ndeclare const headerName: string;\nconst reject',
					),
				}),
				options,
			).toEqual([{ code, message }]);
		}
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
