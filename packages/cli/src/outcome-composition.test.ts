import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { generateOpenApi } from "./openapi.js";
import { validateProject } from "./project.js";

type Json = Record<string, unknown>;

const created = `created: {
			status: 201,
			description: "The project was created.",
			schema: z.object({ kind: z.literal("created"), id: z.string() }),
		}`;
const queued = `queued: {
			status: 201,
			description: "The project was queued for creation.",
			schema: z.object({ kind: z.literal("queued"), ticket: z.number() }),
		}`;

describe("same-status outcomes", () => {
	it("composes literal-discriminated body outcomes into oneOf with a discriminator", () => {
		const document = generateOpenApi(
			project({ "src/routes/projects/route.ts": route(`${queued}, ${created}`) }),
		);

		expect(diagnosticsOf(document)).toEqual([]);
		expect(responseOf(document, 201)).toEqual({
			description:
				"- `created`: The project was created.\n- `queued`: The project was queued for creation.",
			content: {
				"application/json": {
					schema: {
						oneOf: [
							{
								type: "object",
								properties: { kind: { type: "string", const: "created" }, id: { type: "string" } },
								required: ["kind", "id"],
							},
							{
								type: "object",
								properties: {
									kind: { type: "string", const: "queued" },
									ticket: { type: "number" },
								},
								required: ["kind", "ticket"],
							},
						],
						discriminator: { propertyName: "kind" },
					},
				},
			},
		});
	});

	it("selects nothing by source order", () => {
		const forward = generateOpenApi(
			project({ "src/routes/projects/route.ts": route(`${created}, ${queued}`) }),
		);
		const reversed = generateOpenApi(
			project({ "src/routes/projects/route.ts": route(`${queued}, ${created}`) }),
		);

		expect(reversed).toEqual(forward);
	});

	it("chooses the lexicographically first property when several literals discriminate", () => {
		const document = generateOpenApi(
			project({
				"src/routes/projects/route.ts":
					route(`a: { status: 200, schema: z.object({ type: z.literal("x"), kind: z.enum(["one"]) }) },
		b: { status: 200, schema: z.object({ type: z.literal("y"), kind: z.enum(["two"]) }) }`),
			}),
		);

		expect(diagnosticsOf(document)).toEqual([]);
		expect(schemaOf(document, 200).discriminator).toEqual({ propertyName: "kind" });
	});

	it("reads discriminators through component references", () => {
		const document = generateOpenApi(
			project({
				"src/routes/projects/schemas.ts": `import { z } from "zod";

export const Created = z.object({ kind: z.literal("created"), id: z.string() });
export const Queued = z.object({ kind: z.literal("queued") }).meta({ id: "QueuedProject" });
`,
				"src/routes/projects/route.ts": route(
					`created: { status: 201, schema: Created }, queued: { status: 201, schema: Queued }`,
					'import { Created, Queued } from "./schemas";',
				),
			}),
		);

		expect(diagnosticsOf(document)).toEqual([]);
		expect(schemaOf(document, 201)).toEqual({
			oneOf: [
				{ $ref: "#/components/schemas/Created" },
				{ $ref: "#/components/schemas/QueuedProject" },
			],
			discriminator: { propertyName: "kind" },
		});
	});

	it.each([
		[
			"no shared literal",
			`a: { status: 200, schema: z.object({ id: z.string() }) },
		b: { status: 200, schema: z.object({ name: z.string() }) }`,
		],
		[
			"an overlapping literal",
			`a: { status: 200, schema: z.object({ kind: z.literal("same"), id: z.string() }) },
		b: { status: 200, schema: z.object({ kind: z.literal("same"), name: z.string() }) }`,
		],
		[
			"an optional literal",
			`a: { status: 200, schema: z.object({ kind: z.literal("a").optional() }) },
		b: { status: 200, schema: z.object({ kind: z.literal("b") }) }`,
		],
		[
			"a literal only some alternatives share",
			`a: { status: 200, schema: z.object({ kind: z.literal("a") }) },
		b: { status: 200, schema: z.object({ kind: z.literal("b") }) },
		c: { status: 200, schema: z.object({ id: z.string() }) }`,
		],
		[
			"only boolean literals",
			`a: { status: 200, schema: z.object({ ok: z.literal(true) }) },
		b: { status: 200, schema: z.object({ ok: z.literal(false) }) }`,
		],
		[
			"a union alternative",
			`a: { status: 200, schema: z.object({ kind: z.literal("a") }) },
		b: { status: 200, schema: z.union([z.object({ kind: z.literal("b") }), z.string()]) }`,
		],
	])("rejects same-status body outcomes with %s and suggests a fix", (_label, responses) => {
		const diagnostics = errorsOf(project({ "src/routes/projects/route.ts": route(responses) }));

		expect(diagnostics).toEqual([
			expect.objectContaining({
				code: "ROUTA_RESPONSE_STATUS_AMBIGUOUS",
				file: "src/routes/projects/route.ts",
				routePath: "/projects",
				message: expect.stringMatching(/GET \/projects.*status 200.*"a".*"b"/),
				suggestion: expect.stringMatching(/literal discriminator.*distinct status/),
			}),
		]);
	});

	it("rejects body and bodyless outcomes that share a status", () => {
		const diagnostics = errorsOf(
			project({
				"src/routes/projects/route.ts":
					route(`done: { status: 200, schema: z.object({ id: z.string() }) },
		empty: { status: 200 }`),
			}),
		);

		expect(diagnostics).toEqual([
			expect.objectContaining({
				code: "ROUTA_RESPONSE_STATUS_AMBIGUOUS",
				message: expect.stringMatching(/"done".*"empty".*body.*no body|bodyless/),
			}),
		]);
	});

	it("rejects several bodyless outcomes under one status", () => {
		const diagnostics = errorsOf(
			project({
				"src/routes/projects/route.ts":
					route(`ok: { status: 200, schema: z.object({ id: z.string() }) },
		gone: { status: 204 },
		removed: { status: 204, headers: z.object({ "x-removed": z.string() }) }`),
			}),
		);

		expect(diagnostics).toEqual([
			expect.objectContaining({
				code: "ROUTA_RESPONSE_STATUS_AMBIGUOUS",
				message: expect.stringMatching(/"gone".*"removed".*indistinguishable/),
			}),
		]);
	});

	it("projects a compatible header once, required only when every alternative requires it", () => {
		const document = generateOpenApi(
			project({
				"src/routes/projects/route.ts": route(`a: {
			status: 200,
			schema: z.object({ kind: z.literal("a") }),
			headers: z.object({ etag: z.string().describe("Tag."), "x-a": z.string() }),
		},
		b: {
			status: 200,
			schema: z.object({ kind: z.literal("b") }),
			headers: z.object({ etag: z.string().describe("Tag.").optional(), "x-b": z.number() }),
		},
		c: {
			status: 200,
			schema: z.object({ kind: z.literal("c") }),
			headers: z.object({ etag: z.string().describe("Tag.") }),
		}`),
			}),
		);

		expect(diagnosticsOf(document)).toEqual([]);
		expect(responseOf(document, 200).headers).toEqual({
			etag: { description: "Tag.", schema: { type: "string", description: "Tag." } },
			"x-a": { schema: { type: "string" } },
			"x-b": { schema: { type: "number" } },
		});
	});

	it("rejects one header name with different schemas under one status", () => {
		const diagnostics = errorsOf(
			project({
				"src/routes/projects/route.ts":
					route(`a: { status: 200, schema: z.object({ kind: z.literal("a") }), headers: z.object({ etag: z.string() }) },
		b: { status: 200, schema: z.object({ kind: z.literal("b") }), headers: z.object({ etag: z.string().describe("Other.") }) }`),
			}),
		);

		expect(diagnostics).toEqual([
			expect.objectContaining({
				code: "ROUTA_RESPONSE_HEADER_INCOMPATIBLE",
				message: expect.stringMatching(/"etag".*"a".*"b"/),
			}),
		]);
	});

	it("lists a cookie once and marks it always set only when every alternative requires it", () => {
		const document = generateOpenApi(
			project({
				"src/cookies.ts": cookies,
				"src/routes/projects/route.ts": route(
					`a: { status: 200, schema: z.object({ kind: z.literal("a") }), cookies: [{ handle: session, required: true }, theme] },
		b: { status: 200, schema: z.object({ kind: z.literal("b") }), cookies: [session] }`,
					'import { session, theme } from "../../cookies";',
				),
			}),
		);
		const setCookie = (responseOf(document, 200).headers as Record<string, Json>)["Set-Cookie"]!;

		expect(diagnosticsOf(document)).toEqual([]);
		expect(setCookie.required).toBeUndefined();
		expect(String(setCookie.description).match(/"session"/g)).toHaveLength(1);
		expect(setCookie.description).toContain('"theme"');
		expect(setCookie.description).not.toContain("always sets");
	});

	it("rejects different cookie declarations that claim one identity under one status", () => {
		const diagnostics = errorsOf(
			project({
				"src/cookies.ts": `${cookies}
export const otherSession = createCookie({ name: "session", schema: z.string(), httpOnly: false, secure: true, sameSite: "lax", path: "/" });
`,
				"src/routes/projects/route.ts": route(
					`a: { status: 200, schema: z.object({ kind: z.literal("a") }), cookies: [session] },
		b: { status: 200, schema: z.object({ kind: z.literal("b") }), cookies: [otherSession] }`,
					'import { otherSession, session } from "../../cookies";',
				),
			}),
		);

		expect(diagnostics).toEqual([
			expect.objectContaining({
				code: "ROUTA_RESPONSE_COOKIE_CONFLICT",
				message: expect.stringMatching(/"session".*"a".*"b"/),
			}),
		]);
	});
});

describe("terminal middleware rejects", () => {
	const okRoute = route(`ok: { status: 200, schema: z.object({ id: z.string() }) }`);
	const guard = (rejects: string, extra = "") => `import { createMiddleware } from "@routa-ts/core";
import { z } from "zod";
${extra}
export const guard = createMiddleware({
\trejects: { ${rejects} },
\trun: ({ next }) => next(),
});
`;

	it("documents reject headers, cookies, bodies, and descriptions like route outcomes", () => {
		const document = generateOpenApi(
			project({
				"src/cookies.ts": cookies,
				"src/routes/projects/middleware.ts": guard(
					`unauthorized: {
			status: 401,
			description: "Sign in first.",
			schema: z.object({ message: z.string() }),
			headers: z.object({ "www-authenticate": z.string().describe("The challenge.") }),
			cookies: [{ handle: session, required: true }],
		}`,
					'import { session } from "../../cookies";',
				),
				"src/routes/projects/route.ts": okRoute,
			}),
		);
		const unauthorized = responseOf(document, 401);

		expect(diagnosticsOf(document)).toEqual([]);
		expect(unauthorized.description).toBe("Sign in first.");
		expect(unauthorized.content).toEqual({
			"application/json": {
				schema: {
					type: "object",
					properties: { message: { type: "string" } },
					required: ["message"],
				},
			},
		});
		expect(unauthorized.headers).toMatchObject({
			"www-authenticate": {
				required: true,
				description: "The challenge.",
				schema: { type: "string", description: "The challenge." },
			},
			"Set-Cookie": { required: true, schema: { type: "string" } },
		});
		expect(
			(unauthorized.headers as Record<string, Json>)["Set-Cookie"]!.description as string,
		).toContain('"session" (HttpOnly, Secure, SameSite=Lax, Path=/)');
	});

	it.each([
		[
			"a reserved header",
			`denied: { status: 403, headers: z.object({ "content-type": z.string() }) }`,
			"ROUTA_RESPONSE_HEADER_RESERVED",
		],
		[
			"a raw Set-Cookie header",
			`denied: { status: 403, headers: z.object({ "set-cookie": z.string() }) }`,
			"ROUTA_RESPONSE_HEADER_RESERVED",
		],
		[
			"an uppercase header",
			`denied: { status: 403, headers: z.object({ "Retry-After": z.number() }) }`,
			"ROUTA_RESPONSE_HEADER_NAME",
		],
		[
			"an object header value",
			`denied: { status: 403, headers: z.object({ "x-info": z.object({ a: z.string() }) }) }`,
			"ROUTA_RESPONSE_HEADER_VALUE",
		],
		[
			"a cookie that is not a handle",
			`denied: { status: 403, cookies: ["session"] }`,
			"ROUTA_RESPONSE_COOKIE_UNRESOLVED",
		],
		["a spread", `denied: { status: 403, ...shared }`, "ROUTA_SCHEMA_UNSUPPORTED"],
		["a computed status", `denied: { status: 400 + 3 }`, "ROUTA_SCHEMA_UNSUPPORTED"],
		[
			"a computed description",
			`denied: { status: 403, description: \`Denied \${1}\` }`,
			"ROUTA_SCHEMA_UNSUPPORTED",
		],
		[
			"an unreadable schema",
			`denied: { status: 403, schema: makeSchema() }`,
			"ROUTA_SCHEMA_UNSUPPORTED",
		],
		[
			"a schema that changes values",
			`denied: { status: 403, schema: z.object({ message: z.string().trim() }) }`,
			"ROUTA_RESPONSE_SCHEMA_MUTATION",
		],
	])("reports a reject with %s in routa check", (_label, rejects, code) => {
		const diagnostics = errorsOf(
			project({
				"src/routes/projects/middleware.ts": guard(
					rejects,
					"const shared = { status: 403 } as const;\nconst makeSchema = () => z.object({});",
				),
				"src/routes/projects/route.ts": okRoute,
			}),
		);

		expect(diagnostics).toEqual([
			expect.objectContaining({ code, file: "src/routes/projects/middleware.ts" }),
		]);
	});

	it("reports a reject rejects object Routa cannot read", () => {
		const diagnostics = errorsOf(
			project({
				"src/routes/projects/middleware.ts": `import { createMiddleware } from "@routa-ts/core";

const rejects = { denied: { status: 403 } } as const;

export const guard = createMiddleware({ rejects: { ...rejects }, run: ({ next }) => next() });
`,
				"src/routes/projects/route.ts": okRoute,
			}),
		);

		expect(diagnostics).toEqual([
			expect.objectContaining({
				code: "ROUTA_SCHEMA_UNSUPPORTED",
				message: expect.stringContaining("middleware rejects need static status"),
			}),
		]);
	});

	it("reports a reject header the route's lifecycle headers own", () => {
		const diagnostics = errorsOf(
			project({
				"src/routa.ts":
					'import { createRouta } from "@routa-ts/core";\n\nexport default createRouta({ lifecycleHeaders: true });\n',
				"src/routes/projects/middleware.ts": guard(
					`denied: { status: 403, headers: z.object({ sunset: z.string() }) }`,
				),
				"src/routes/projects/route.ts": route(
					`ok: { status: 200, schema: z.object({ id: z.string() }) }`,
					"",
					{ deprecation: '{ sunset: "2030-01-01" }' },
				),
			}),
		);

		expect(diagnostics).toEqual([
			expect.objectContaining({ code: "ROUTA_RESPONSE_HEADER_LIFECYCLE" }),
		]);
	});

	it("reports a reject body reachable from a HEAD route", () => {
		const files = (method: string) =>
			project({
				"src/routes/projects/middleware.ts": guard(
					`denied: { status: 403, schema: z.object({ message: z.string() }) }, gone: { status: 410 }`,
				),
				"src/routes/projects/route.ts": route(`ok: { status: 200 }`, "", { method }),
			});

		expect(errorsOf(files("get"))).toEqual([]);
		expect(errorsOf(files("head"))).toEqual([
			expect.objectContaining({
				code: "ROUTA_RESPONSE_BODYLESS_SCHEMA",
				file: "src/routes/projects/route.ts",
				routePath: "/projects",
				message: expect.stringContaining('middleware guard reject "denied"'),
			}),
		]);
	});

	it("composes a reject with a route outcome under one status", () => {
		const cwd = (routeOutcome: string) =>
			project({
				"src/routes/projects/middleware.ts": guard(
					`tooLarge: { status: 400, schema: z.object({ kind: z.literal("tooLarge"), limit: z.number() }) }`,
				),
				"src/routes/projects/route.ts": route(`ok: { status: 200 }, ${routeOutcome}`),
			});
		const document = generateOpenApi(
			cwd(`invalid: { status: 400, schema: z.object({ kind: z.literal("invalid") }) }`),
		);

		expect(diagnosticsOf(document)).toEqual([]);
		expect(schemaOf(document, 400)).toMatchObject({
			oneOf: [
				{ properties: { kind: { const: "invalid" } } },
				{ properties: { kind: { const: "tooLarge" } } },
			],
			discriminator: { propertyName: "kind" },
		});
		expect(
			errorsOf(cwd(`invalid: { status: 400, schema: z.object({ message: z.string() }) }`)),
		).toEqual([
			expect.objectContaining({
				code: "ROUTA_RESPONSE_STATUS_AMBIGUOUS",
				message: expect.stringContaining('"invalid", "tooLarge" (a reject of middleware guard)'),
			}),
		]);
	});

	it("reports an outcome name the route and a middleware both declare", () => {
		const diagnostics = errorsOf(
			project({
				"src/routes/projects/middleware.ts": guard(`unauthorized: { status: 401 }`),
				"src/routes/projects/route.ts": route(
					`ok: { status: 200 }, unauthorized: { status: 401, description: "Again." }`,
				),
			}),
		);

		expect(diagnostics).toEqual([
			expect.objectContaining({
				code: "ROUTA_OUTCOME_NAME_COLLISION",
				message: 'Outcome "unauthorized" is declared by the route and by middleware guard',
			}),
		]);
	});
});

const cookies = `import { createCookie } from "@routa-ts/core";
import { z } from "zod";

export const session = createCookie({ name: "session", schema: z.string(), httpOnly: true, secure: true, sameSite: "lax", path: "/" });
export const theme = createCookie({ name: "theme", schema: z.string(), httpOnly: false, secure: false, sameSite: "lax", path: "/" });
`;

function project(files: Record<string, string>): string {
	const cwd = mkdtempSync(join(tmpdir(), "routa-outcome-composition-"));
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

function route(
	responses: string,
	imports = "",
	options: { method?: string; path?: string; middleware?: string; deprecation?: string } = {},
): string {
	return `import { createRoute, createRouteRoot } from "@routa-ts/core";
import { z } from "zod";
${imports}
export default createRouteRoot(${JSON.stringify(options.path ?? "/projects")})({
\t${options.method ?? "get"}: createRoute({
${options.middleware ? `\t\tmiddleware: [${options.middleware}],\n` : ""}${options.deprecation ? `\t\tdeprecation: ${options.deprecation},\n` : ""}\t\tresponses: { ${responses} },
\t\trun: async () => ({}) as never,
\t}),
});
`;
}

function errorsOf(cwd: string) {
	return validateProject(cwd, { write: false }).diagnostics;
}

function diagnosticsOf(document: unknown): unknown[] {
	return ((document as Json)["x-routa-diagnostics"] as unknown[] | undefined) ?? [];
}

function responseOf(document: unknown, status: number, path = "/projects", method = "get"): Json {
	const operation = (document as { paths: Record<string, Record<string, Json>> }).paths[path]![
		method
	]!;
	return (operation.responses as Record<string, Json>)[String(status)]!;
}

function schemaOf(document: unknown, status: number): Json {
	return ((responseOf(document, status).content as Json)["application/json"] as Json)
		.schema as Json;
}
