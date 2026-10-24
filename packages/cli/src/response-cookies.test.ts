import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createCookie } from "@routa-ts/core";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { run } from "./index.js";
import { generateOpenApi } from "./openapi.js";
import { validateProject } from "./project.js";

type Json = Record<string, unknown>;

const session = `export const session = createCookie({
	name: "session",
	schema: z.string(),
	httpOnly: true,
	secure: true,
	sameSite: "lax",
	path: "/",
	maxAge: 3600,
});
`;

const theme = `export const theme = createCookie({
	name: "theme",
	schema: z.enum(["light", "dark"]),
	httpOnly: false,
	secure: false,
	sameSite: "strict",
	path: "/app",
	domain: "example.com",
	expires: "2030-01-01T00:00:00Z",
});
`;

const adminSession = session
	.replace("export const session", "export const admin")
	.replace('path: "/"', 'path: "/admin"');

const cookieFile = (...handles: string[]) =>
	`import { createCookie } from "@routa-ts/core";\nimport { z } from "zod";\n\n${handles.join("\n")}`;

describe("response cookie OpenAPI", () => {
	it("documents declared cookies through one standard Set-Cookie header", () => {
		const cwd = project({
			"src/cookies.ts": cookieFile(session, theme),
			"src/routes/items/route.ts": route(
				"/items",
				"ok: { status: 200, schema: z.object({ id: z.string() }), cookies: [session, theme] }",
				{ imports: 'import { session, theme } from "../../cookies";' },
			),
		});

		const document = generateOpenApi(cwd);
		const response = responseOf(document, "/items", "get", 200);

		expect(diagnosticsOf(document)).toEqual([]);
		expect(response.headers).toEqual({
			"Set-Cookie": {
				description:
					'Routa sends each declared cookie as its own repeated Set-Cookie field, never as one comma-joined value. This response may set or clear: "session" (HttpOnly, Secure, SameSite=Lax, Path=/, Max-Age=3600); "theme" (SameSite=Strict, Domain=example.com, Path=/app, Expires=2030-01-01T00:00:00Z).',
				schema: { type: "string" },
			},
		});
		expect(JSON.stringify(document)).not.toMatch(/x-routa/);
	});

	it("documents cookies on bodyless outcomes next to declared headers", () => {
		const cwd = project({
			"src/cookies.ts": cookieFile(session),
			"src/routes/items/route.ts": route(
				"/items",
				`done: { status: 204, headers: z.object({ etag: z.string() }), cookies: [session] },
		ok: { status: 200 }`,
				{ imports: 'import { session } from "../../cookies";' },
			),
		});

		const response = responseOf(generateOpenApi(cwd), "/items", "get", 204);

		expect(response.content).toBeUndefined();
		expect(Object.keys(response.headers as Json).sort()).toEqual(["Set-Cookie", "etag"]);
	});

	it("never exposes values, examples, or secrets", () => {
		const cwd = project({
			"src/cookies.ts": cookieFile(
				`export const session = createCookie({
	name: "session",
	schema: z.string().meta({ examples: ["s3cr3t-token"], description: "s3cr3t-description" }),
	httpOnly: true,
	secure: true,
	sameSite: "lax",
	path: "/",
});`,
			),
			"src/routes/items/route.ts": route("/items", "ok: { status: 200, cookies: [session] }", {
				imports: 'import { session } from "../../cookies";',
			}),
		});

		const text = JSON.stringify(generateOpenApi(cwd));

		expect(text).not.toContain("s3cr3t");
		expect(text).toContain('"Set-Cookie"');
	});

	it("omits Set-Cookie when an outcome declares no cookies", () => {
		const cwd = project({
			"src/routes/items/route.ts": route("/items", "ok: { status: 200 }"),
		});

		expect(responseOf(generateOpenApi(cwd), "/items", "get", 200)).not.toHaveProperty("headers");
	});

	it("detects drift when a documented cookie is added or removed", async () => {
		const cwd = project({
			"src/cookies.ts": cookieFile(session),
			"src/routes/items/route.ts": route("/items", "ok: { status: 200, cookies: [session] }", {
				imports: 'import { session } from "../../cookies";',
			}),
		});
		writeFileSync(
			join(cwd, ".routa/openapi-baseline.json"),
			JSON.stringify(generateOpenApi(cwd), null, "\t"),
		);

		expect(await run(["openapi", "check"], { cwd })).toMatchObject({ code: 0 });

		writeFileSync(join(cwd, "src/routes/items/route.ts"), route("/items", "ok: { status: 200 }"));

		const check = await run(["openapi", "check"], { cwd });
		expect(check.code).toBe(1);
		expect(check.stderr).toContain("OPENAPI_DRIFT: GET /items schema changed");
	});
});

describe("response cookie handle resolution", () => {
	const codes = (cwd: string) =>
		validateProject(cwd, { write: false }).diagnostics.map((item) => [item.code, item.message]);

	it("resolves a handle declared in the route file", () => {
		const cwd = project({
			"src/routes/items/route.ts": route("/items", "ok: { status: 200, cookies: [local] }", {
				imports: `import { createCookie } from "@routa-ts/core";\n${session.replace("export const session", "const local")}`,
			}),
		});

		expect(codes(cwd)).toEqual([]);
		expect(setCookieOf(cwd)).toContain('"session"');
	});

	it("resolves handles through relative imports, aliases, and re-exports", () => {
		const cwd = project({
			"src/cookies/session.ts": cookieFile(session),
			"src/cookies/index.ts": 'export { session as auth } from "./session";\n',
			"src/shared.ts": 'export { auth as shared } from "./cookies";\n',
			"src/routes/items/route.ts": route("/items", "ok: { status: 200, cookies: [shared] }", {
				imports: 'import { shared } from "../../shared";',
			}),
		});

		expect(codes(cwd)).toEqual([]);
		expect(setCookieOf(cwd)).toContain('"session"');
	});

	it("resolves a handle declared next to the route's schemas", () => {
		const cwd = project({
			"src/routes/items/schemas.ts": cookieFile(session),
			"src/routes/items/route.ts": route("/items", "ok: { status: 200, cookies: [session] }"),
		});

		expect(codes(cwd)).toEqual([]);
		expect(setCookieOf(cwd)).toContain('"session"');
	});

	it("reports a handle Routa cannot find", () => {
		for (const [imports, cookies] of [
			['import { session } from "some-package";', "[session]"],
			["", "[missing]"],
			["const session = 1;", "[session]"],
			["", "[...other]"],
			["", "cookiesList"],
		] as const) {
			const cwd = project({
				"src/routes/items/route.ts": route("/items", `ok: { status: 200, cookies: ${cookies} }`, {
					imports,
				}),
			});

			expect(codes(cwd), `${imports} ${cookies}`).toEqual([
				["ROUTA_RESPONSE_COOKIE_UNRESOLVED", expect.stringContaining("createCookie")],
			]);
		}
	});

	it("accepts a returned cookies field in run results", () => {
		const cwd = project({
			"src/cookies.ts": cookieFile(session),
			"src/routes/items/route.ts": `import { createRoute, createRouteRoot } from "@routa-ts/core";
import { session } from "../../cookies";

export default createRouteRoot("/items")({
	get: createRoute({
		responses: { ok: { status: 200, cookies: [session] } },
		run: () => ({ type: "ok", cookies: [session.set("x")] }),
	}),
});
`,
		});

		expect(codes(cwd)).toEqual([]);
	});
});

describe("response cookie declaration checks", () => {
	const codes = (cwd: string) =>
		validateProject(cwd, { write: false }).diagnostics.map((item) => [item.code, item.message]);
	const warnings = (cwd: string) =>
		validateProject(cwd, { write: false }).warnings.map((item) => [item.code, item.message]);

	const withHandle = (handle: string) =>
		project({
			"src/cookies.ts": cookieFile(handle),
			"src/routes/items/route.ts": route("/items", "ok: { status: 200, cookies: [cookie] }", {
				imports: 'import { cookie } from "../../cookies";',
			}),
		});
	const handle = (properties: string) => `export const cookie = createCookie({ ${properties} });`;
	const complete =
		'name: "a", schema: z.string(), httpOnly: true, secure: true, sameSite: "lax", path: "/"';

	it("accepts every supported attribute", () => {
		const cwd = withHandle(
			handle(
				`${complete}, domain: ".example.com", maxAge: 60, expires: "2030-01-01T00:00:00Z", partitioned: true`,
			),
		);

		expect(codes(cwd)).toEqual([]);
	});

	it("requires attributes to be literals", () => {
		const cases = [
			'name: "a", schema: z.string(), httpOnly: true, secure: true, sameSite: "lax", path: base.path',
			`${complete}, maxAge: 60 * 60`,
			`${complete}, domain: process.env.DOMAIN`,
			`${complete}, partitioned: flag`,
			`name: prefix + "a", schema: z.string(), httpOnly: true, secure: true, sameSite: "lax", path: "/"`,
			`...base, name: "a"`,
		];

		for (const properties of cases) {
			const cwd = withHandle(
				`const base = { schema: z.string(), httpOnly: true, secure: true, sameSite: "lax", path: "/" } as const;\nconst flag = true;\nconst prefix = "x";\n${handle(properties)}`,
			);

			expect(codes(cwd), properties).toEqual([
				["ROUTA_RESPONSE_COOKIE_STATIC", expect.stringContaining("literal")],
			]);
		}
	});

	it("requires the explicit attributes", () => {
		for (const missing of ["httpOnly", "secure", "sameSite", "path"]) {
			const properties = complete
				.split(", ")
				.filter((item) => !item.startsWith(missing))
				.join(", ");

			expect(codes(withHandle(handle(properties))), missing).toEqual([
				["ROUTA_RESPONSE_COOKIE_ATTRIBUTE", expect.stringContaining(missing)],
			]);
		}
	});

	it("rejects invalid names and attribute values", () => {
		const names = ['"bad name"', '"a;b"', '""', '"a=b"'];

		for (const name of names) {
			expect(codes(withHandle(handle(complete.replace('"a"', name)))), name).toEqual([
				["ROUTA_RESPONSE_COOKIE_NAME", expect.stringContaining("name")],
			]);
		}

		for (const override of [
			'path: "app"',
			'path: "/a;b"',
			'domain: "bad domain"',
			"maxAge: -1",
			"maxAge: 1.5",
			'expires: "tomorrow"',
			'sameSite: "Lax"',
			'httpOnly: "yes"',
		]) {
			const key = override.split(":")[0]!;
			const properties = complete
				.split(", ")
				.filter((item) => !item.startsWith(key))
				.concat(override)
				.join(", ");

			expect(codes(withHandle(handle(properties))), override).toEqual([
				["ROUTA_RESPONSE_COOKIE_ATTRIBUTE", expect.stringContaining(key)],
			]);
		}
	});

	it("enforces SameSite=None, Partitioned, and prefix rules", () => {
		const insecure = complete.replace("secure: true", "secure: false");
		const cases: Array<[string, string]> = [
			[`${insecure.replace('"lax"', '"none"')}`, "SameSite=None"],
			[`${insecure}, partitioned: true`, "Partitioned"],
			[insecure.replace('"a"', '"__Secure-a"'), "__Secure-"],
			[insecure.replace('"a"', '"__secure-a"'), "__Secure-"],
			[insecure.replace('"a"', '"__Host-a"'), "__Host-"],
			[complete.replace('"a"', '"__Host-a"').replace('path: "/"', 'path: "/app"'), "__Host-"],
			[`${complete.replace('"a"', '"__Host-a"')}, domain: "example.com"`, "__Host-"],
		];

		for (const [properties, mention] of cases) {
			expect(codes(withHandle(handle(properties))), properties).toEqual([
				["ROUTA_RESPONSE_COOKIE_RULE", expect.stringContaining(mention)],
			]);
		}

		expect(
			codes(withHandle(handle(complete.replace('"a"', '"__Host-a"')))),
			"a valid __Host- cookie",
		).toEqual([]);
	});

	it("rejects value schemas that are not scalar", () => {
		const cwd = withHandle(handle(complete.replace("z.string()", "z.object({ id: z.string() })")));

		expect(codes(cwd)).toEqual([
			["ROUTA_RESPONSE_COOKIE_VALUE", expect.stringContaining("string, number, or boolean")],
		]);
	});

	it("rejects value schemas that change values", () => {
		const cwd = withHandle(handle(complete.replace("z.string()", "z.string().trim()")));

		expect(codes(cwd)).toEqual([
			["ROUTA_RESPONSE_SCHEMA_MUTATION", expect.stringContaining("trim")],
		]);
	});

	it("fails an outcome that declares one identity twice", () => {
		const cwd = project({
			"src/cookies.ts": cookieFile(
				session,
				session
					.replace("export const session", "export const again")
					.replace("maxAge: 3600", "maxAge: 60"),
			),
			"src/routes/items/route.ts": route(
				"/items",
				"ok: { status: 200, cookies: [session, again] }",
				{
					imports: 'import { session, again } from "../../cookies";',
				},
			),
		});

		expect(codes(cwd)).toEqual([
			["ROUTA_RESPONSE_COOKIE_CONFLICT", expect.stringContaining('"session"')],
		]);
	});

	it("fails an outcome that lists one handle twice", () => {
		const cwd = project({
			"src/cookies.ts": cookieFile(session),
			"src/routes/items/route.ts": route(
				"/items",
				"ok: { status: 200, cookies: [session, session] }",
				{
					imports: 'import { session } from "../../cookies";',
				},
			),
		});

		expect(codes(cwd)).toEqual([
			["ROUTA_RESPONSE_COOKIE_CONFLICT", expect.stringContaining('"session"')],
		]);
	});

	it("warns, without failing, when the same name has different scopes", () => {
		const cwd = project({
			"src/cookies.ts": cookieFile(session, adminSession),
			"src/routes/items/route.ts": route(
				"/items",
				"ok: { status: 200, cookies: [session, admin] }",
				{
					imports: 'import { session, admin } from "../../cookies";',
				},
			),
		});

		expect(codes(cwd)).toEqual([]);
		expect(warnings(cwd)).toEqual([
			["ROUTA_RESPONSE_COOKIE_SCOPE", expect.stringContaining('"session"')],
		]);
	});

	it("does not warn for different names or for the same cookie in different outcomes", () => {
		const cwd = project({
			"src/cookies.ts": cookieFile(session, theme),
			"src/routes/items/route.ts": route(
				"/items",
				"ok: { status: 200, cookies: [session, theme] }, other: { status: 201, cookies: [session] }",
				{ imports: 'import { session, theme } from "../../cookies";' },
			),
		});

		expect(warnings(cwd)).toEqual([]);
	});

	it("keeps a raw Set-Cookie header an error that points to cookies", () => {
		const cwd = project({
			"src/routes/items/route.ts": route(
				"/items",
				'ok: { status: 200, headers: z.object({ "set-cookie": z.string() }) }',
			),
		});

		expect(codes(cwd)).toEqual([
			["ROUTA_RESPONSE_HEADER_RESERVED", expect.stringContaining("Set-Cookie")],
		]);
	});

	it("prints warnings from routa check without failing it", async () => {
		const cwd = project({
			"src/cookies.ts": cookieFile(session, adminSession),
			"src/routes/items/route.ts": route(
				"/items",
				"ok: { status: 200, cookies: [session, admin] }",
				{
					imports: 'import { session, admin } from "../../cookies";',
				},
			),
		});

		const result = validateProject(cwd, { write: false });

		expect(result.diagnostics).toEqual([]);
		expect(result.warnings).toHaveLength(1);
	});
});

/**
 * The same attribute rules run in three places: TypeScript, createCookie at runtime, and
 * `routa check`. Each case here must be accepted or rejected by the last two alike.
 */
describe("response cookie rule parity", () => {
	const complete = {
		name: '"a"',
		schema: "z.string()",
		httpOnly: "true",
		secure: "true",
		sameSite: '"lax"',
		path: '"/"',
	} as Record<string, string>;
	const base = {
		schema: z.string(),
		httpOnly: true,
		secure: true,
		sameSite: "lax",
		path: "/",
	};

	const cases: Array<{ name: string; overrides: Record<string, string>; accepted: boolean }> = [
		{ name: "plain", overrides: {}, accepted: true },
		{ name: "SameSite=None with Secure", overrides: { sameSite: '"none"' }, accepted: true },
		{
			name: "SameSite=None without Secure",
			overrides: { sameSite: '"none"', secure: "false" },
			accepted: false,
		},
		{ name: "Partitioned with Secure", overrides: { partitioned: "true" }, accepted: true },
		{
			name: "Partitioned without Secure",
			overrides: { partitioned: "true", secure: "false" },
			accepted: false,
		},
		{ name: "__Secure-", overrides: { name: '"__Secure-a"' }, accepted: true },
		{
			name: "__Secure- without Secure",
			overrides: { name: '"__Secure-a"', secure: "false" },
			accepted: false,
		},
		{
			name: "lowercase prefix",
			overrides: { name: '"__secure-a"', secure: "false" },
			accepted: false,
		},
		{ name: "__Host-", overrides: { name: '"__Host-a"' }, accepted: true },
		{
			name: "__Host- with Domain",
			overrides: { name: '"__Host-a"', domain: '"example.com"' },
			accepted: false,
		},
		{ name: "__Host- with Path", overrides: { name: '"__Host-a"', path: '"/x"' }, accepted: false },
		{ name: "domain", overrides: { domain: '"sub.example.com"' }, accepted: true },
		{ name: "leading-dot domain", overrides: { domain: '".example.com"' }, accepted: true },
		{ name: "bad domain", overrides: { domain: '"-bad-.com"' }, accepted: false },
		{ name: "maxAge zero", overrides: { maxAge: "0" }, accepted: true },
		{ name: "negative maxAge", overrides: { maxAge: "-1" }, accepted: false },
		{ name: "expires", overrides: { expires: '"2030-01-01T00:00:00.500+02:00"' }, accepted: true },
		{ name: "date-only expires", overrides: { expires: '"2030-01-01"' }, accepted: false },
		{
			name: "impossible expires",
			overrides: { expires: '"2030-13-45T00:00:00Z"' },
			accepted: false,
		},
		{ name: "path with semicolon", overrides: { path: '"/a;b"' }, accepted: false },
		{ name: "token punctuation", overrides: { name: '"a!#$%&\'*+-.^_`|~1"' }, accepted: true },
		{ name: "name with comma", overrides: { name: '"a,b"' }, accepted: false },
		{ name: "number value", overrides: { schema: "z.number().int()" }, accepted: true },
		{ name: "enum value", overrides: { schema: 'z.enum(["a", "b"])' }, accepted: true },
		{ name: "array value", overrides: { schema: "z.array(z.string())" }, accepted: false },
		{
			name: "transformed value",
			overrides: { schema: "z.string().transform((v) => v)" },
			accepted: false,
		},
		{ name: "defaulted value", overrides: { schema: 'z.string().default("x")' }, accepted: false },
	];

	for (const item of cases) {
		it(`${item.name}: createCookie and routa check agree`, () => {
			const properties = Object.entries({ ...complete, ...item.overrides })
				.map(([key, value]) => `${key}: ${value}`)
				.join(", ");
			const cwd = project({
				"src/cookies.ts": cookieFile(`export const cookie = createCookie({ ${properties} });`),
				"src/routes/items/route.ts": route("/items", "ok: { status: 200, cookies: [cookie] }", {
					imports: 'import { cookie } from "../../cookies";',
				}),
			});
			const checked = validateProject(cwd, { write: false }).diagnostics.length === 0;
			const created = (() => {
				try {
					createCookie(runtimeConfig(item.overrides, base) as never);
					return true;
				} catch {
					return false;
				}
			})();

			expect(checked, "routa check").toBe(item.accepted);
			expect(created, "createCookie").toBe(item.accepted);
		});
	}
});

function runtimeConfig(overrides: Record<string, string>, base: Record<string, unknown>) {
	const evaluate = (expression: string) =>
		new Function("z", `return (${expression});`)(z) as unknown;

	return {
		...base,
		name: "a",
		...Object.fromEntries(Object.entries(overrides).map(([key, value]) => [key, evaluate(value)])),
	};
}

function setCookieOf(cwd: string): string {
	const document = generateOpenApi(cwd);
	const response = responseOf(document, "/items", "get", 200);
	return String(
		((response.headers as Json | undefined)?.["Set-Cookie"] as Json | undefined)?.description,
	);
}

function project(files: Record<string, string>): string {
	const cwd = mkdtempSync(join(tmpdir(), "routa-response-cookies-"));
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

function route(path: string, responses: string, options: { imports?: string } = {}): string {
	return `import { createRoute, createRouteRoot } from "@routa-ts/core";
import { z } from "zod";
${options.imports ?? ""}
export default createRouteRoot(${JSON.stringify(path)})({
\tget: createRoute({
\t\tresponses: { ${responses} },
\t\trun: async () => ({ type: "ok", data: {} as never }),
\t}),
});
`;
}

function diagnosticsOf(document: unknown): unknown[] {
	return ((document as Json)["x-routa-diagnostics"] as unknown[] | undefined) ?? [];
}

function responseOf(document: unknown, path: string, method: string, status: number): Json {
	const operation = (document as { paths: Record<string, Record<string, Json>> }).paths[path]?.[
		method
	];
	return (operation?.responses as Record<string, Json>)[String(status)] ?? {};
}
