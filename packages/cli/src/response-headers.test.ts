import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { run } from "./index.js";
import { generateOpenApi } from "./openapi.js";
import { validateProject } from "./project.js";

type Json = Record<string, unknown>;

describe("response header OpenAPI", () => {
	it("documents required and optional headers with their schema, required flag, and metadata", () => {
		const cwd = project({
			"src/routes/items/route.ts": route(
				"/items",
				`ok: {
			status: 200,
			schema: z.object({ id: z.string() }),
			headers: z.object({
				etag: z.string().describe("Entity tag of the item."),
				"x-total-count": z.number().int().meta({ examples: [42], title: "Total" }),
				"x-cached": z.boolean().optional(),
				"cache-control": z.literal("no-store"),
				"x-mode": z.enum(["fast", "slow"]),
			}),
		}`,
			),
		});

		const document = generateOpenApi(cwd);

		expect(diagnosticsOf(document)).toEqual([]);
		expect(responseOf(document, "/items", "get", 200).headers).toEqual({
			etag: {
				required: true,
				description: "Entity tag of the item.",
				schema: { type: "string", description: "Entity tag of the item." },
			},
			"x-total-count": {
				required: true,
				schema: { type: "integer", examples: [42], title: "Total" },
			},
			"x-cached": { schema: { type: "boolean" } },
			"cache-control": { required: true, schema: { type: "string", const: "no-store" } },
			"x-mode": { required: true, schema: { type: "string", enum: ["fast", "slow"] } },
		});
	});

	it("documents headers on bodyless outcomes without content", () => {
		const cwd = project({
			"src/routes/items/route.ts": route(
				"/items",
				`created: { status: 201, headers: z.object({ location: z.string() }) },
		notModified: { status: 304, headers: z.object({ etag: z.string() }) },
		ok: { status: 200, schema: z.object({ id: z.string() }) }`,
			),
		});

		const document = generateOpenApi(cwd);
		const created = responseOf(document, "/items", "get", 201);

		expect(diagnosticsOf(document)).toEqual([]);
		expect(created.content).toBeUndefined();
		expect(created.headers).toEqual({ location: { required: true, schema: { type: "string" } } });
		expect(responseOf(document, "/items", "get", 304).content).toBeUndefined();
	});

	it("omits headers when an outcome declares none", () => {
		const cwd = project({
			"src/routes/items/route.ts": route(
				"/items",
				"ok: { status: 200, schema: z.object({ id: z.string() }) }",
			),
		});

		expect(responseOf(generateOpenApi(cwd), "/items", "get", 200)).not.toHaveProperty("headers");
	});

	it("reads header schemas from schemas.ts, keeping component references", () => {
		const cwd = project({
			"src/routes/items/schemas.ts": `import { z } from "zod";

export const Etag = z.string().meta({ id: "Etag", description: "An entity tag." });
export const ItemHeaders = z.object({ etag: Etag, "retry-after": z.number().optional() });
`,
			"src/routes/items/route.ts": route("/items", "ok: { status: 200, headers: ItemHeaders }", {
				imports: 'import { ItemHeaders } from "./schemas";',
			}),
		});

		const document = generateOpenApi(cwd);

		expect(diagnosticsOf(document)).toEqual([]);
		expect(responseOf(document, "/items", "get", 200).headers).toEqual({
			etag: {
				required: true,
				description: "An entity tag.",
				schema: { $ref: "#/components/schemas/Etag" },
			},
			"retry-after": { schema: { type: "number" } },
		});
		expect((document.components?.schemas as Json).ItemHeaders).toBeUndefined();
		expect((document.components?.schemas as Json).Etag).toEqual({
			type: "string",
			description: "An entity tag.",
		});
	});

	it("describes a header from the referencing schema before the shared component", () => {
		const cwd = project({
			"src/routes/items/schemas.ts": `import { z } from "zod";

export const Etag = z.string().meta({ id: "HeaderEtag", description: "Generic" });
export const ItemHeaders = z.object({
	etag: Etag.optional().describe("Specific"),
	"x-trace": Etag.optional().meta({ description: "From meta" }),
	"x-plain": Etag,
	"x-other": Etag.optional(),
});
`,
			"src/routes/items/route.ts": route("/items", "ok: { status: 200, headers: ItemHeaders }", {
				imports: 'import { ItemHeaders } from "./schemas";',
			}),
		});

		const document = generateOpenApi(cwd);
		const headers = responseOf(document, "/items", "get", 200).headers as Record<string, Json>;

		expect(diagnosticsOf(document)).toEqual([]);
		expect(headers.etag.description).toBe("Specific");
		expect(headers["x-trace"].description).toBe("From meta");
		expect(headers["x-plain"].description).toBe("Generic");
		expect(headers["x-other"].description).toBe("Generic");
		expect((document.components?.schemas as Json).HeaderEtag).toEqual({
			type: "string",
			description: "Generic",
		});
	});

	it("classifies and describes headers through chains of exported wrappers", () => {
		const cwd = project({
			"src/routes/items/schemas.ts": `import { z } from "zod";

export const Etag = z.string().describe("Entity tag");
export const OptionalEtag = Etag.optional();
export const Revision = z.number().int();
export const FrozenRevision = Revision.readonly();
export const ItemHeaders = z.object({ etag: OptionalEtag, "x-revision": FrozenRevision });
`,
			"src/routes/items/route.ts": route("/items", "ok: { status: 200, headers: ItemHeaders }", {
				imports: 'import { ItemHeaders } from "./schemas";',
			}),
		});

		const document = generateOpenApi(cwd);

		expect(validateProject(cwd, { write: false }).diagnostics).toEqual([]);
		expect(responseOf(document, "/items", "get", 200).headers).toEqual({
			etag: { description: "Entity tag", schema: { $ref: "#/components/schemas/OptionalEtag" } },
			"x-revision": { required: true, schema: { $ref: "#/components/schemas/FrozenRevision" } },
		});
		expect(document.components?.schemas).toMatchObject({
			OptionalEtag: { $ref: "#/components/schemas/Etag" },
			FrozenRevision: { $ref: "#/components/schemas/Revision" },
		});
	});

	it("drifts against a baseline when a header changes", async () => {
		const cwd = project({
			"src/routes/items/route.ts": route(
				"/items",
				"ok: { status: 200, headers: z.object({ etag: z.string() }) }",
			),
		});
		writeFileSync(
			join(cwd, ".routa/openapi-baseline.json"),
			JSON.stringify(generateOpenApi(cwd), null, "\t"),
		);

		expect(await run(["openapi", "check"], { cwd })).toMatchObject({ code: 0 });

		writeFileSync(
			join(cwd, "src/routes/items/route.ts"),
			route("/items", "ok: { status: 200, headers: z.object({ etag: z.number() }) }"),
		);

		const check = await run(["openapi", "check"], { cwd });
		expect(check.code).toBe(1);
		expect(check.stderr).toContain("OPENAPI_DRIFT: GET /items schema changed");
	});
});

describe("response header results in routa check", () => {
	it("accepts a returned headers field next to type and data", () => {
		const cwd = project({
			"src/routes/items/route.ts": `import { createRoute, createRouteRoot } from "@routa-ts/core";
import { z } from "zod";

export default createRouteRoot("/items")({
\tget: createRoute({
\t\tresponses: {
\t\t\tok: { status: 200, schema: z.object({ id: z.string() }), headers: z.object({ etag: z.string() }) },
\t\t},
\t\trun: () => ({ type: "ok", data: { id: "1" }, headers: { etag: "a" } }),
\t}),
});
`,
		});

		expect(validateProject(cwd, { write: false }).diagnostics).toEqual([]);
	});

	it("still rejects other extra fields", () => {
		const cwd = project({
			"src/routes/items/route.ts": `import { createRoute, createRouteRoot } from "@routa-ts/core";
import { z } from "zod";

export default createRouteRoot("/items")({
\tget: createRoute({
\t\tresponses: { ok: { status: 200, schema: z.object({ id: z.string() }) } },
\t\trun: () => ({ type: "ok", data: { id: "1" }, cookies: {} }),
\t}),
});
`,
		});

		const [diagnostic] = validateProject(cwd, { write: false }).diagnostics;
		expect(diagnostic.code).toBe("ROUTA_RESULT_SHAPE");
		expect(diagnostic.message).toContain('"type", "data", and "headers"');
	});
});

describe("response header declaration checks", () => {
	const codes = (cwd: string) =>
		validateProject(cwd, { write: false }).diagnostics.map((item) => [item.code, item.message]);

	it("accepts supported declarations", () => {
		const cwd = project({
			"src/routes/items/route.ts": route(
				"/items",
				`ok: {
			status: 200,
			headers: z.object({
				etag: z.string().min(1).max(64),
				"retry-after": z.number().int().optional(),
				"x-flag": z.boolean(),
				"x-kind": z.union([z.literal("a"), z.literal(1)]),
				location: z.url(),
			}),
		}`,
			),
		});

		expect(codes(cwd)).toEqual([]);
	});

	it("rejects header names that are not lowercase", () => {
		const cwd = project({
			"src/routes/items/route.ts": route(
				"/items",
				"ok: { status: 200, headers: z.object({ ETag: z.string() }) }",
			),
		});

		expect(codes(cwd)).toEqual([
			[
				"ROUTA_RESPONSE_HEADER_NAME",
				expect.stringContaining('Header "ETag" must be declared in lowercase ("etag")'),
			],
		]);
	});

	it("rejects names that are not valid header names", () => {
		const cwd = project({
			"src/routes/items/route.ts": route(
				"/items",
				'ok: { status: 200, headers: z.object({ "x bad": z.string() }) }',
			),
		});

		expect(codes(cwd)).toEqual([
			["ROUTA_RESPONSE_HEADER_NAME", expect.stringContaining('"x bad" is not a valid header name')],
		]);
	});

	it("rejects headers that differ only in case", () => {
		const cwd = project({
			"src/routes/items/route.ts": route(
				"/items",
				"ok: { status: 200, headers: z.object({ etag: z.string(), ETag: z.string() }) }",
			),
		});

		expect(codes(cwd)).toEqual([
			[
				"ROUTA_RESPONSE_HEADER_COLLISION",
				expect.stringContaining('"etag" and "ETag" differ only in case'),
			],
		]);
	});

	it("rejects every header Routa owns", () => {
		for (const name of [
			"content-type",
			"content-length",
			"transfer-encoding",
			"connection",
			"set-cookie",
		]) {
			const cwd = project({
				"src/routes/items/route.ts": route(
					"/items",
					`ok: { status: 200, headers: z.object({ "${name}": z.string() }) }`,
				),
			});

			expect(codes(cwd), name).toEqual([
				["ROUTA_RESPONSE_HEADER_RESERVED", expect.stringContaining(`"${name}"`)],
			]);
		}
	});

	it("reports mixed-case reserved names as reserved", () => {
		const cwd = project({
			"src/routes/items/route.ts": route(
				"/items",
				'ok: { status: 200, headers: z.object({ "Content-Type": z.string() }) }',
			),
		});

		expect(codes(cwd)).toEqual([
			["ROUTA_RESPONSE_HEADER_RESERVED", expect.stringContaining('"Content-Type"')],
		]);
	});

	it("points set-cookie at response cookies", () => {
		const cwd = project({
			"src/routes/items/route.ts": route(
				"/items",
				'ok: { status: 200, headers: z.object({ "set-cookie": z.string() }) }',
			),
		});
		const [diagnostic] = validateProject(cwd, { write: false }).diagnostics;

		expect(diagnostic.code).toBe("ROUTA_RESPONSE_HEADER_RESERVED");
		expect(diagnostic.message).toContain("Set-Cookie");
		expect(diagnostic.suggestion).toMatch(/cookie/i);
	});

	it("rejects values other than strings, numbers, and booleans", () => {
		for (const schema of [
			"z.array(z.string())",
			"z.object({ a: z.string() })",
			"z.string().nullable()",
			"z.null()",
			"z.unknown()",
			"z.union([z.string(), z.array(z.string())])",
		]) {
			const cwd = project({
				"src/routes/items/route.ts": route(
					"/items",
					`ok: { status: 200, headers: z.object({ "x-value": ${schema} }) }`,
				),
			});

			expect(codes(cwd), schema).toEqual([
				[
					"ROUTA_RESPONSE_HEADER_VALUE",
					expect.stringContaining('Header "x-value" must be a string, number, or boolean'),
				],
			]);
		}
	});

	it("rejects header schemas that change values", () => {
		const cwd = project({
			"src/routes/items/route.ts": route(
				"/items",
				`ok: {
			status: 200,
			headers: z.object({
				etag: z.string().trim(),
				"x-limit": z.number().default(10),
				"x-code": z.string().transform((value) => value.toUpperCase()),
			}),
		}`,
			),
		});

		expect(codes(cwd).map(([code]) => code)).toEqual([
			"ROUTA_RESPONSE_SCHEMA_MUTATION",
			"ROUTA_RESPONSE_SCHEMA_MUTATION",
			"ROUTA_RESPONSE_SCHEMA_MUTATION",
		]);
	});

	it("reports a headers declaration Routa cannot read instead of dropping it", () => {
		const cwd = project({
			"src/routes/items/route.ts": route(
				"/items",
				"ok: { status: 200, headers: z.object({ etag: z.string() }).extend({ x: z.string() }) }",
			),
		});
		const unresolved = project({
			"src/routes/items/route.ts": route("/items", "ok: { status: 200, headers: Imported }"),
		});

		expect(codes(cwd).map(([code]) => code)).toEqual(["ROUTA_SCHEMA_UNSUPPORTED"]);
		expect(codes(unresolved).map(([code]) => code)).toEqual(["ROUTA_SCHEMA_UNRESOLVED"]);
	});

	it("rejects a headers declaration that is not an object schema", () => {
		const cwd = project({
			"src/routes/items/route.ts": route("/items", "ok: { status: 200, headers: z.string() }"),
		});

		expect(codes(cwd)).toEqual([
			["ROUTA_SCHEMA_UNSUPPORTED", expect.stringContaining("Response headers must be an object")],
		]);
	});

	describe("lifecycle headers", () => {
		const deprecated = (headers: string, deprecation: string) =>
			route("/items", `ok: { status: 200, headers: z.object({ ${headers} }) }`, { deprecation });
		const enabled =
			'import { createRouta } from "@routa-ts/core";\n\nexport default createRouta({ lifecycleHeaders: true });\n';

		it("rejects headers the lifecycle owns when lifecycle headers are enabled", () => {
			for (const name of ["deprecation", "sunset", "link"]) {
				const cwd = project({
					"src/routa.ts": enabled,
					"src/routes/items/route.ts": deprecated(
						`${name}: z.string()`,
						'{ sunset: "Wed, 01 Jan 2031 00:00:00 GMT", replacement: "https://example.com/v2/items" }',
					),
				});

				expect(codes(cwd), name).toEqual([
					["ROUTA_RESPONSE_HEADER_LIFECYCLE", expect.stringContaining(`"${name}"`)],
				]);
			}
		});

		it("leaves link to the application when the deprecation names no replacement", () => {
			const cwd = project({
				"src/routa.ts": enabled,
				"src/routes/items/route.ts": deprecated("link: z.string()", "{}"),
			});

			expect(codes(cwd)).toEqual([]);
		});

		it("treats a lifecycleHeaders setting other than a literal false as possibly enabled", () => {
			const replacement = '{ replacement: "https://example.com/v2/items" }';
			const configs: Array<[string, string, string[]]> = [
				[
					"computed",
					'createRouta({ lifecycleHeaders: process.env.LIFECYCLE === "1" })',
					["ROUTA_RESPONSE_HEADER_LIFECYCLE"],
				],
				["shorthand", "createRouta({ lifecycleHeaders })", ["ROUTA_RESPONSE_HEADER_LIFECYCLE"]],
				[
					"literal true",
					"createRouta({ lifecycleHeaders: true })",
					["ROUTA_RESPONSE_HEADER_LIFECYCLE"],
				],
				["literal false", "createRouta({ lifecycleHeaders: false })", []],
				["omitted", "createRouta({})", []],
			];

			for (const [label, call, expected] of configs) {
				const cwd = project({
					"src/routa.ts": `import { createRouta } from "@routa-ts/core";\n\nconst lifecycleHeaders = Boolean(process.env.LIFECYCLE);\n\nexport default ${call};\n`,
					"src/routes/items/route.ts": deprecated("deprecation: z.string()", replacement),
				});

				expect(
					codes(cwd).map(([code]) => code),
					label,
				).toEqual(expected);
			}
		});

		it("reads a deprecation declared as a local constant before computing ownership", () => {
			const declared = (name: string) =>
				`const ${name} = { replacement: "https://example.com/v2/items" };\n`;
			const forms = [
				["shorthand", "deprecation", "deprecation"],
				["identifier", "legacy", "deprecation: legacy"],
			];

			for (const [label, name, property] of forms) {
				const cwd = project({
					"src/routa.ts": enabled,
					"src/routes/items/route.ts": route(
						"/items",
						"ok: { status: 200, headers: z.object({ link: z.string() }) }",
						{ deprecationProperty: property, imports: declared(name) },
					),
				});

				expect(codes(cwd), label).toEqual([
					["ROUTA_RESPONSE_HEADER_LIFECYCLE", expect.stringContaining('"link"')],
				]);
			}
		});

		it("leaves link to the application when a local deprecation constant names no replacement", () => {
			const cwd = project({
				"src/routa.ts": enabled,
				"src/routes/items/route.ts": route(
					"/items",
					"ok: { status: 200, headers: z.object({ link: z.string() }) }",
					{ deprecation: "legacy", imports: "const legacy = {};\n" },
				),
			});

			expect(codes(cwd)).toEqual([]);
		});

		it("reports a deprecation it cannot read when a link header depends on it", () => {
			const cwd = project({
				"src/routa.ts": enabled,
				"src/routes/items/route.ts": route(
					"/items",
					"ok: { status: 200, headers: z.object({ link: z.string() }) }",
					{ deprecation: "legacy", imports: 'import { legacy } from "../../legacy";' },
				),
				"src/legacy.ts": 'export const legacy = { replacement: "https://example.com/v2/items" };\n',
			});

			expect(codes(cwd)).toEqual([
				[
					"ROUTA_SCHEMA_UNSUPPORTED",
					expect.stringContaining("deprecation needs a static object with literal properties"),
				],
			]);
		});

		it("allows the headers when lifecycle headers are off or the route is not deprecated", () => {
			const off = project({
				"src/routes/items/route.ts": deprecated(
					"deprecation: z.string(), sunset: z.string(), link: z.string()",
					'{ replacement: "https://example.com/v2/items" }',
				),
			});
			const notDeprecated = project({
				"src/routa.ts": enabled,
				"src/routes/items/route.ts": route(
					"/items",
					"ok: { status: 200, headers: z.object({ deprecation: z.string() }) }",
				),
			});

			expect(codes(off)).toEqual([]);
			expect(codes(notDeprecated)).toEqual([]);
		});
	});
});

function project(files: Record<string, string>): string {
	const cwd = mkdtempSync(join(tmpdir(), "routa-response-headers-"));
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
	path: string,
	responses: string,
	options: { imports?: string; deprecation?: string; deprecationProperty?: string } = {},
): string {
	const property =
		options.deprecationProperty
		?? (options.deprecation ? `deprecation: ${options.deprecation}` : undefined);
	const deprecation = property ? `\t\t${property},\n` : "";
	return `import { createRoute, createRouteRoot } from "@routa-ts/core";
import { z } from "zod";
${options.imports ?? ""}
export default createRouteRoot(${JSON.stringify(path)})({
\tget: createRoute({
${deprecation}\t\tresponses: { ${responses} },
\t\trun: async () => ({ type: "ok", data: {} as never }),
\t}),
});
`;
}

function diagnosticsOf(document: unknown): unknown[] {
	return ((document as Json)["x-routa-diagnostics"] as unknown[] | undefined) ?? [];
}

function responseOf(document: unknown, path: string, method: string, status: number): Json {
	const operation = (document as { paths: Record<string, Record<string, Json>> }).paths[path][
		method
	];
	return (operation.responses as Record<string, Json>)[String(status)];
}
