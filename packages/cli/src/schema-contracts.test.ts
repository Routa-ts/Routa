import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { run } from "./index.js";
import { generateOpenApi } from "./openapi.js";
import { validateProject } from "./project.js";

type Json = Record<string, unknown>;

describe("schema contracts", () => {
	it("projects native unions, intersections, and and() as OpenAPI 3.1 that agrees with z.toJSONSchema", () => {
		const schemas = `export const Cat = z.object({ kind: z.literal("cat"), lives: z.number() });
export const Dog = z.object({ kind: z.literal("dog"), good: z.boolean() });
export const Pet = z.discriminatedUnion("kind", [Cat, Dog]);
export const Named = z.object({ name: z.string() });
export const Aged = z.object({ age: z.number() });
export const Person = z.intersection(Named, Aged);
export const Owner = Named.and(z.object({ pets: z.array(Pet) }));
export const SearchResult = z.union([Person, z.string(), z.null()]);
export const Either = z.object({ value: z.string().optional().or(z.number()) });
export const Report = z.object({
	pet: Pet,
	person: Person,
	owner: Owner,
	result: SearchResult,
	either: Either,
	inline: z.object({ a: z.string() }).and(z.object({ b: z.number().optional() })),
	described: z.intersection(z.object({ a: z.string() }).describe("Left side"), z.object({ b: z.number() })),
});
`;
		const cwd = project({
			"src/routes/report/schemas.ts": schemasFile(schemas),
			"src/routes/report/route.ts": routeFile("/report", {
				responses: "ok: { status: 200, schema: Report }",
			}),
		});

		const document = generateOpenApi(cwd);
		const components = document.components?.schemas ?? {};

		expect(diagnosticsOf(document)).toEqual([]);
		expect(components.Pet).toEqual({
			oneOf: [{ $ref: "#/components/schemas/Cat" }, { $ref: "#/components/schemas/Dog" }],
			discriminator: { propertyName: "kind" },
		});
		expect(components.Person).toEqual({
			allOf: [{ $ref: "#/components/schemas/Named" }, { $ref: "#/components/schemas/Aged" }],
		});
		expect(components.SearchResult).toEqual({
			anyOf: [{ $ref: "#/components/schemas/Person" }, { type: "string" }, { type: "null" }],
		});
		expect((components.Report as Json).properties).toMatchObject({
			inline: {
				type: "object",
				required: ["a"],
				properties: { a: { type: "string" }, b: { type: "number" } },
			},
			described: {
				allOf: [
					{
						type: "object",
						required: ["a"],
						properties: { a: { type: "string" } },
						description: "Left side",
					},
					{ type: "object", required: ["b"], properties: { b: { type: "number" } } },
				],
			},
		});
		expect(semantic(responseSchema(document, "/report", "get", 200), components)).toEqual(
			nativeSchema(runtimeSchemas(schemas).Report),
		);
	});

	it("reports response schemas that change values, including same-type mutations", async () => {
		const cwd = project({
			"src/routes/items/schemas.ts": schemasFile(`export const Item = z.object({
	name: z.string().trim(),
	slug: z.string().toLowerCase(),
	count: z.coerce.number(),
	tags: z.array(z.string()).default([]),
	label: z.string().transform((value) => value.toUpperCase()),
	code: z.string().pipe(z.coerce.number()),
	raw: z.preprocess((value) => String(value), z.string()),
});
`),
			"src/routes/items/route.ts": routeFile("/items", {
				responses: "ok: { status: 200, schema: Item }",
			}),
		});

		const { diagnostics } = validateProject(cwd, { write: false });

		expect(diagnostics.map((item) => [item.code, item.file, item.message])).toEqual([
			[
				"ROUTA_RESPONSE_SCHEMA_MUTATION",
				"src/routes/items/schemas.ts",
				"Response schema changes values with .trim(): z.string().trim()",
			],
			[
				"ROUTA_RESPONSE_SCHEMA_MUTATION",
				"src/routes/items/schemas.ts",
				"Response schema changes values with .toLowerCase(): z.string().toLowerCase()",
			],
			[
				"ROUTA_RESPONSE_SCHEMA_MUTATION",
				"src/routes/items/schemas.ts",
				"Response schema changes values with z.coerce.number(): z.coerce.number()",
			],
			[
				"ROUTA_RESPONSE_SCHEMA_MUTATION",
				"src/routes/items/schemas.ts",
				"Response schema changes values with .default(): z.array(z.string()).default([])",
			],
			[
				"ROUTA_RESPONSE_SCHEMA_MUTATION",
				"src/routes/items/schemas.ts",
				"Response schema changes values with .transform(): z.string().transform((value) => value.toUpperCase())",
			],
			[
				"ROUTA_RESPONSE_SCHEMA_MUTATION",
				"src/routes/items/schemas.ts",
				"Response schema changes values with .pipe() into a different schema: z.string().pipe(z.coerce.number())",
			],
			[
				"ROUTA_RESPONSE_SCHEMA_MUTATION",
				"src/routes/items/schemas.ts",
				"Response schema changes values with z.preprocess(): z.preprocess((value) => String(value), z.string())",
			],
		]);

		const check = await run(["check"], { cwd });
		expect(check.code).toBe(1);
		expect(check.stderr).toContain(
			"ROUTA_RESPONSE_SCHEMA_MUTATION: src/routes/items/schemas.ts: Response schema changes values with .trim()",
		);
		expect(check.stderr).toContain("Suggestion: Response schemas describe wire-ready JSON.");
	});

	it("reports the remaining output-changing constructs in route outcomes and middleware rejects", () => {
		const cwd = project({
			"src/routes/items/schemas.ts": schemasFile(`export const Item = z.object({
	code: z.string().toUpperCase(),
	text: z.string().normalize(),
	rounded: z.number().overwrite((value) => Math.round(value)),
	checked: z.string().check(z.minLength(1), z.overwrite((value) => value.trim())),
	trimmed: z.string().check(z.trim()),
	status: z.enum(["on", "off"]).catch("off"),
	when: z.codec(z.iso.datetime(), z.date(), {
		decode: (value) => new Date(value),
		encode: (value) => value.toISOString(),
	}),
});
`),
			"src/routes/items/route.ts": routeFile("/items", {
				imports: 'import { guard } from "../../middleware/guard.js";',
				responses: "ok: { status: 200, schema: Item }",
			}).replace("\tget: createRoute({", "\tmiddleware: [guard],\n\tget: createRoute({"),
			"src/middleware/guard.ts": `import { createMiddleware } from "@routa-ts/core";
import { z } from "zod";

export const guard = createMiddleware({
	rejects: {
		denied: { status: 403, schema: z.object({ message: z.string().trim() }) },
	},
	run: ({ next }) => next({}),
});
`,
		});

		const { diagnostics } = validateProject(cwd, { write: false });

		expect(diagnostics.map((item) => [item.code, item.file, item.message])).toEqual([
			[
				"ROUTA_RESPONSE_SCHEMA_MUTATION",
				"src/routes/items/schemas.ts",
				"Response schema changes values with .toUpperCase(): z.string().toUpperCase()",
			],
			[
				"ROUTA_RESPONSE_SCHEMA_MUTATION",
				"src/routes/items/schemas.ts",
				"Response schema changes values with .normalize(): z.string().normalize()",
			],
			[
				"ROUTA_RESPONSE_SCHEMA_MUTATION",
				"src/routes/items/schemas.ts",
				"Response schema changes values with .overwrite(): z.number().overwrite((value) => Math.round(value))",
			],
			[
				"ROUTA_RESPONSE_SCHEMA_MUTATION",
				"src/routes/items/schemas.ts",
				"Response schema changes values with z.overwrite(): z.overwrite((value) => value.trim())",
			],
			[
				"ROUTA_RESPONSE_SCHEMA_MUTATION",
				"src/routes/items/schemas.ts",
				"Response schema changes values with z.trim(): z.trim()",
			],
			[
				"ROUTA_RESPONSE_SCHEMA_MUTATION",
				"src/routes/items/schemas.ts",
				'Response schema changes values with .catch(): z.enum(["on", "off"]).catch("off")',
			],
			[
				"ROUTA_RESPONSE_SCHEMA_MUTATION",
				"src/routes/items/schemas.ts",
				"Response schema changes values with a codec: z.codec(z.iso.datetime(), z.date(), { decode: (value) => new Date(value), encode",
			],
			[
				"ROUTA_RESPONSE_SCHEMA_MUTATION",
				"src/middleware/guard.ts",
				"Response schema changes values with .trim(): z.string().trim()",
			],
		]);
	});

	it("projects the incoming side of transformed and coerced input, agreeing with z.toJSONSchema", () => {
		const schemas = `export const SearchQuery = z.object({
	limit: z.coerce.number().int().optional(),
	page: z.coerce.number().default(1),
	mode: z.enum(["fast", "full"]).catch("fast"),
	term: z.string().trim().toLowerCase(),
	tags: z.string().transform((value) => value.split(",")),
	from: z.string().pipe(z.coerce.number()),
});
export const CreateBody = z.object({
	name: z.string().transform((value) => value.trim()),
	count: z.number().default(0),
});
`;
		const cwd = project({
			"src/routes/search/schemas.ts": schemasFile(schemas),
			"src/routes/search/route.ts": routeFile("/search", {
				method: "post",
				input: "query: SearchQuery, body: CreateBody",
				responses: "ok: { status: 200, schema: z.object({ ok: z.boolean() }) }",
			}),
		});

		const { diagnostics, warnings } = validateProject(cwd, { write: false });
		const document = generateOpenApi(cwd);
		const operation = (document.paths as Record<string, Record<string, Json>>)["/search"].post;

		expect([...diagnostics, ...warnings]).toEqual([]);
		expect(operation.parameters).toEqual([
			{ name: "limit", in: "query", required: false, schema: { type: "integer" } },
			{ name: "page", in: "query", required: false, schema: { type: "number" } },
			{
				name: "mode",
				in: "query",
				required: false,
				schema: { type: "string", enum: ["fast", "full"] },
			},
			{ name: "term", in: "query", required: true, schema: { type: "string" } },
			{ name: "tags", in: "query", required: true, schema: { type: "string" } },
			{ name: "from", in: "query", required: true, schema: { type: "string" } },
		]);
		expect(document.components?.schemas?.CreateBody).toEqual({
			type: "object",
			required: ["name"],
			properties: { name: { type: "string" }, count: { type: "number" } },
		});

		const runtime = runtimeSchemas(schemas);
		const oracle = (schema: z.ZodType) => nativeSchema(schema, "input");
		// Zod's converter keeps a `.catch()` key required because its declared input
		// type is required, but the parser accepts a missing key, so Routa documents it
		// as optional.
		const nativeQuery = oracle(runtime.SearchQuery) as Json;
		expect(semantic(parameterObject(operation.parameters as Json[]))).toEqual({
			...nativeQuery,
			required: (nativeQuery.required as string[]).filter((name) => name !== "mode"),
		});
		expect(semantic(document.components?.schemas?.CreateBody)).toEqual(oracle(runtime.CreateBody));
	});

	it("warns when opaque preprocessing hides the incoming side", async () => {
		const cwd = project({
			"src/routes/import/schemas.ts": schemasFile(`export const ImportBody = z.object({
	when: z.preprocess((value) => new Date(String(value)).toISOString(), z.string()),
	raw: z.transform((value) => String(value)).pipe(z.string()),
});
`),
			"src/routes/import/route.ts": routeFile("/import", {
				method: "post",
				input: "body: ImportBody",
				responses: "ok: { status: 200, schema: z.object({ ok: z.boolean() }) }",
			}),
		});

		const { diagnostics, warnings } = validateProject(cwd, { write: false });
		const document = generateOpenApi(cwd);

		expect(diagnostics).toEqual([]);
		expect(warnings.map((item) => [item.code, item.severity, item.file])).toEqual([
			["ROUTA_SCHEMA_OPAQUE_INPUT", "warning", "src/routes/import/schemas.ts"],
			["ROUTA_SCHEMA_OPAQUE_INPUT", "warning", "src/routes/import/schemas.ts"],
		]);
		expect(warnings[0].message).toBe(
			"z.preprocess() accepts input Routa cannot describe, so OpenAPI documents the schema after preprocessing: z.preprocess((value) => new Date(String(value)).toISOString(), z.string())",
		);
		expect(document.components?.schemas?.ImportBody).toEqual({
			type: "object",
			required: ["when", "raw"],
			properties: { when: { type: "string" }, raw: { type: "string" } },
		});
		expect((document as Json)["x-routa-schema-warnings"]).toEqual(
			warnings.map((item) => ({ code: item.code, message: `${item.file}: ${item.message}` })),
		);

		const check = await run(["check"], { cwd });
		expect(check.stderr).toContain(
			"Warning: ROUTA_SCHEMA_OPAQUE_INPUT: src/routes/import/schemas.ts: z.preprocess() accepts input",
		);
		expect(check.stdout).toContain("Routa validation passed for 1 route file(s).");
	});

	it("carries literal metadata to root, nested, inline, and referenced schemas", () => {
		const schemas = `export const Address = z
	.object({ city: z.string().describe("City name") })
	.meta({
		id: "PostalAddress",
		title: "Address",
		description: "A postal address",
		examples: [{ city: "Lima" }],
		"x-internal": false,
	});
export const Account = z
	.object({
		id: z.string().meta({ description: "Account id", example: "acc_1", readOnly: true }),
		password: z.string().meta({ writeOnly: true }),
		address: Address,
		legacyCode: z
			.string()
			.optional()
			.meta({ deprecated: true, externalDocs: { url: "https://example.com/legacy" } }),
		giftAddress: Address.describe("Where to send gifts"),
	})
	.meta({ title: "Account", description: "An account" });
`;
		const cwd = project({
			"src/routes/account/schemas.ts": schemasFile(schemas),
			"src/routes/account/route.ts": routeFile("/account", {
				responses: `ok: { status: 200, schema: Account },
		invalid: { status: 400, schema: z.object({ message: z.string() }).describe("Problem details") }`,
			}),
		});

		const document = generateOpenApi(cwd);
		const components = document.components?.schemas ?? {};
		const address = {
			type: "object",
			required: ["city"],
			properties: { city: { type: "string", description: "City name" } },
			title: "Address",
			examples: [{ city: "Lima" }],
			"x-internal": false,
		};

		expect(diagnosticsOf(document)).toEqual([]);
		expect(Object.keys(components)).toEqual(["Account", "PostalAddress"]);
		expect(components.PostalAddress).toEqual({ ...address, description: "A postal address" });
		expect(components.Account).toEqual({
			type: "object",
			required: ["id", "password", "address", "giftAddress"],
			properties: {
				id: { type: "string", description: "Account id", example: "acc_1", readOnly: true },
				password: { type: "string", writeOnly: true },
				address: { $ref: "#/components/schemas/PostalAddress" },
				legacyCode: {
					type: "string",
					deprecated: true,
					externalDocs: { url: "https://example.com/legacy" },
				},
				giftAddress: { ...address, description: "Where to send gifts" },
			},
			title: "Account",
			description: "An account",
		});
		expect(responseSchema(document, "/account", "get", 200)).toEqual({
			$ref: "#/components/schemas/Account",
		});
		expect(responseSchema(document, "/account", "get", 400)).toEqual({
			type: "object",
			required: ["message"],
			properties: { message: { type: "string" } },
			description: "Problem details",
		});
		expect(semantic(responseSchema(document, "/account", "get", 200), components)).toEqual(
			nativeSchema(runtimeSchemas(schemas).Account),
		);
	});

	it("documents Zod string formats and sized numbers", () => {
		const cwd = project({
			"src/routes/hosts/route.ts": routeFile("/hosts", {
				responses: `ok: { status: 200, schema: z.object({
			address: z.ipv4(),
			id: z.uuidv7(),
			opensAt: z.iso.time(),
			key: z.cuid2(),
			contact: z.string().email(),
			port: z.int32(),
		}) }`,
			}),
		});
		const document = generateOpenApi(cwd);

		expect(diagnosticsOf(document)).toEqual([]);
		expect((responseSchema(document, "/hosts", "get", 200) as Json).properties).toEqual({
			address: { type: "string", format: "ipv4" },
			id: { type: "string", format: "uuid" },
			opensAt: { type: "string", format: "time" },
			key: { type: "string" },
			contact: { type: "string", format: "email" },
			port: { type: "integer" },
		});
	});

	it("reports metadata misuse, registries, and unsupported expressions instead of emitting empty schemas", () => {
		const cwd = project({
			"src/routes/misuse/schemas.ts": schemasFile(`const label = "computed";
z.globalRegistry.add(z.string(), { description: "hidden" });
export const Misuse = z.object({
	structural: z.string().meta({ type: "integer" }),
	placement: z.string().meta({ in: "query" }),
	computed: z.string().describe(label),
	unknownKey: z.string().meta({ color: "red" }),
	badId: z.string().meta({ id: "has space" }),
	registered: z.string().register(z.globalRegistry, { description: "x" }),
	tuple: z.tuple([z.string(), z.number()]),
	extended: z.object({ a: z.string() }).extend({ b: z.string() }),
	helper: makeSchema(),
	imported: Shared,
	notZod: {} as never,
});
`).replace(
				'import { z } from "zod";',
				'import { z } from "zod";\nimport { Shared } from "../shared.js";',
			),
			"src/routes/misuse/route.ts": routeFile("/misuse", {
				responses: "ok: { status: 200, schema: Misuse }",
			}),
		});

		const { diagnostics } = validateProject(cwd, { write: false });
		const document = generateOpenApi(cwd);

		expect(diagnostics.map((item) => [item.code, item.message])).toEqual([
			[
				"ROUTA_SCHEMA_REGISTRY",
				"Zod globalRegistry metadata is not part of the route contract: z.globalRegistry",
			],
			[
				"ROUTA_SCHEMA_META_STRUCTURAL",
				'Metadata "type" would override the schema structure Zod already defines: type: "integer"',
			],
			[
				"ROUTA_SCHEMA_META_PLACEMENT",
				'Metadata "in" describes where a value appears in a route, which the route contract already decides: in: "query"',
			],
			[
				"ROUTA_SCHEMA_META_COMPUTED",
				"Schema metadata cannot be analyzed statically: .describe() needs a string literal: z.string().describe(label)",
			],
			["ROUTA_SCHEMA_META_UNSUPPORTED", 'Metadata "color" is not supported: color: "red"'],
			[
				"ROUTA_SCHEMA_COMPONENT_ID_INVALID",
				'Schema id "has space" is not a valid OpenAPI component name: id: "has space"',
			],
			[
				"ROUTA_SCHEMA_REGISTRY",
				'Zod registry metadata is not part of the route contract: z.string().register(z.globalRegistry, { description: "x" })',
			],
			[
				"ROUTA_SCHEMA_UNSUPPORTED",
				"Unsupported schema for OpenAPI (z.tuple() is not supported): z.tuple([z.string(), z.number()])",
			],
			[
				"ROUTA_SCHEMA_UNSUPPORTED",
				"Unsupported schema for OpenAPI (.extend() is not supported): z.object({ a: z.string() }).extend({ b: z.string() })",
			],
			[
				"ROUTA_SCHEMA_UNSUPPORTED",
				"Unsupported schema for OpenAPI (calls to makeSchema() cannot be analyzed statically): makeSchema()",
			],
			[
				"ROUTA_SCHEMA_UNRESOLVED",
				"Schema Shared is imported, and Routa reads schemas only from the route's schemas.ts or the declaring file: Shared",
			],
			[
				"ROUTA_SCHEMA_UNSUPPORTED",
				"Unsupported schema for OpenAPI (expected a Zod schema expression): {} as never",
			],
		]);
		expect(new Set(diagnostics.map((item) => item.file))).toEqual(
			new Set(["src/routes/misuse/schemas.ts"]),
		);
		expect(diagnostics.every((item) => item.suggestion)).toBe(true);
		expect(document.paths).toEqual({});
		expect(diagnosticsOf(document)).toHaveLength(diagnostics.length);
	});

	it("reads shorthand contract properties and reports input and types it cannot document", () => {
		const cwd = project({
			"src/routes/notes/route.ts": routeFile("/notes", {
				input: "query",
				responses: "ok: { status: 200, schema }",
			}).replace(
				"export default",
				`const query = z.object({ q: z.string() });
const schema = z.object({ id: z.string() });

export default`,
			),
			"src/routes/spread/route.ts": routeFile("/spread", {
				input: "...shared",
				responses: "ok: { status: 200, schema: z.object({ at: z.date() }) }",
			})
				.replace('import { z } from "zod";', 'import { globalRegistry, z } from "zod";')
				.replace(
					"export default",
					`const shared = { query: z.object({ q: z.string() }) };
globalRegistry.add(z.string(), { description: "hidden" });

export default`,
				),
		});

		const { diagnostics } = validateProject(cwd, { write: false });

		expect(diagnostics.map((item) => [item.code, item.file, item.message])).toEqual([
			[
				"ROUTA_SCHEMA_REGISTRY",
				"src/routes/spread/route.ts",
				"Zod globalRegistry metadata is not part of the route contract: globalRegistry",
			],
			[
				"ROUTA_SCHEMA_UNSUPPORTED",
				"src/routes/spread/route.ts",
				"Unsupported schema for OpenAPI (route input needs static params, query, headers, cookies, or body properties): ...shared",
			],
			[
				"ROUTA_SCHEMA_UNSUPPORTED",
				"src/routes/spread/route.ts",
				"Unsupported schema for OpenAPI (z.date() values are not JSON; use z.iso.datetime()): z.date()",
			],
		]);

		const notes = (
			generateOpenApi(
				project({
					"src/routes/notes/route.ts": readFileSync(join(cwd, "src/routes/notes/route.ts"), "utf8"),
				}),
			).paths as Record<string, Record<string, Json>>
		)["/notes"].get;

		expect(notes.parameters).toEqual([
			{ name: "q", in: "query", required: true, schema: { type: "string" } },
		]);
		expect((notes.responses as Record<string, Json>)["200"].content).toEqual({
			"application/json": {
				schema: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
			},
		});
	});

	it("names components from ids and export names and rejects identity collisions", () => {
		const shared = `export const User = z.object({ id: z.string() });
export const GetUserResponse = User;
`;
		const valid = project({
			"src/routes/users/schemas.ts": schemasFile(shared),
			"src/routes/users/route.ts": routeFile("/users", {
				responses: "ok: { status: 200, schema: z.object({ users: z.array(User) }) }",
			}),
			"src/routes/users/$id/schemas.ts": schemasFile(shared),
			"src/routes/users/$id/route.ts": routeFile("/users/:id", {
				input: "params: z.object({ id: UserId })",
				responses: "ok: { status: 200, schema: GetUserResponse }",
			}).replace(
				"export default",
				'const UserId = z.string().meta({ id: "UserId" });\n\nexport default',
			),
		});
		const validDocument = generateOpenApi(valid);

		expect(diagnosticsOf(validDocument)).toEqual([]);
		expect(validDocument.components?.schemas).toEqual({
			User: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
			UserId: { type: "string" },
		});
		expect(responseSchema(validDocument, "/users/{id}", "get", 200)).toEqual({
			$ref: "#/components/schemas/User",
		});
		expect(
			(validDocument.paths as Record<string, Record<string, Json>>)["/users/{id}"].get.parameters,
		).toEqual([
			{ name: "id", in: "path", required: true, schema: { $ref: "#/components/schemas/UserId" } },
		]);

		const colliding = project({
			"src/routes/a/schemas.ts": schemasFile(`export const Thing = z.object({ id: z.string() });
export const Tagged = z.object({ id: z.string() }).meta({ id: "Tag" });
`),
			"src/routes/a/route.ts": routeFile("/a", {
				responses: "ok: { status: 200, schema: z.object({ thing: Thing, tag: Tagged }) }",
			}),
			"src/routes/b/schemas.ts": schemasFile(`export const Thing = z.object({ id: z.number() });
export const Label = z.object({ id: z.string() }).meta({ id: "Tag" });
`),
			"src/routes/b/route.ts": routeFile("/b", {
				responses: "ok: { status: 200, schema: z.object({ thing: Thing, tag: Label }) }",
			}),
		});
		const { diagnostics } = validateProject(colliding, { write: false });

		expect(diagnostics.map((item) => [item.code, item.message])).toEqual([
			[
				"ROUTA_SCHEMA_COMPONENT_COLLISION",
				"Different schemas named Thing in src/routes/a/schemas.ts and src/routes/b/schemas.ts would share one OpenAPI component.",
			],
			[
				"ROUTA_SCHEMA_COMPONENT_COLLISION",
				"Different schemas in src/routes/a/schemas.ts and src/routes/b/schemas.ts claim component Tag.",
			],
		]);
	});

	it("resolves middleware reject schemas from the middleware's own file", () => {
		const middleware = (
			rejectSchema: string,
			extra = "",
		) => `import { createMiddleware } from "@routa-ts/core";
import { z } from "zod";
${extra}
const Problem = z.object({ message: z.string() });

export const guard = createMiddleware({
	rejects: { denied: { status: 403, schema: ${rejectSchema} } },
	run: ({ next }) => next({}),
});
`;
		const routes = {
			"src/routes/admin/route.ts": routeFile("/admin", {
				imports: 'import { guard } from "../../middleware/guard.js";',
				responses: "ok: { status: 200, schema: z.object({ ok: z.boolean() }) }",
			}).replace("\tget: createRoute({", "\tmiddleware: [guard],\n\tget: createRoute({"),
		};
		const local = project({
			...routes,
			"src/middleware/guard.ts": middleware("Problem"),
		});
		const localDocument = generateOpenApi(local);

		expect(diagnosticsOf(localDocument)).toEqual([]);
		expect(responseSchema(localDocument, "/admin", "get", 403)).toEqual({
			type: "object",
			required: ["message"],
			properties: { message: { type: "string" } },
		});

		const imported = project({
			...routes,
			"src/middleware/guard.ts": middleware("Shared", 'import { Shared } from "./shared.js";'),
		});

		expect(validateProject(imported, { write: false }).diagnostics).toEqual([
			expect.objectContaining({ code: "ROUTA_SCHEMA_UNRESOLVED", file: "src/middleware/guard.ts" }),
		]);
	});

	it("projects Routa's Sort and Fields query helpers as their incoming strings", () => {
		const cwd = project({
			"src/routes/projects/schemas.ts": `import { Fields, Sort } from "@routa-ts/core/query/helpers";
import { z } from "zod";

export const ListProjectsQuery = z.object({
	sort: Sort(["name", "status"] as const).optional(),
	fields: Fields(["id", "name"] as const).optional(),
});
`,
			"src/routes/projects/route.ts": routeFile("/projects", {
				input: "query: ListProjectsQuery",
				responses: "ok: { status: 200, schema: z.object({ ok: z.boolean() }) }",
			}),
		});
		const document = generateOpenApi(cwd);

		expect(diagnosticsOf(document)).toEqual([]);
		expect(
			(document.paths as Record<string, Record<string, Json>>)["/projects"].get.parameters,
		).toEqual([
			{ name: "sort", in: "query", required: false, schema: { type: "string" } },
			{ name: "fields", in: "query", required: false, schema: { type: "string" } },
		]);
	});

	it("compares component content, not $ref spelling, in openapi check", async () => {
		const cwd = project({
			"src/routes/users/schemas.ts": schemasFile(`export const User = z.object({ id: z.string() });
`),
			"src/routes/users/route.ts": routeFile("/users", {
				responses: "ok: { status: 200, schema: User }",
			}),
		});
		const inlineBaseline = {
			openapi: "3.1.0",
			info: { title: "Routa API", version: "0.0.0" },
			paths: {
				"/users": {
					get: {
						responses: {
							"200": {
								description: "Users",
								content: {
									"application/json": {
										schema: {
											type: "object",
											required: ["id"],
											properties: { id: { type: "string" } },
										},
									},
								},
							},
						},
					},
				},
			},
		};
		writeFileSync(join(cwd, ".routa/openapi-baseline.json"), JSON.stringify(inlineBaseline));

		expect((await run(["openapi", "check"], { cwd })).code).toBe(0);

		writeFileSync(
			join(cwd, "src/routes/users/schemas.ts"),
			schemasFile("export const User = z.object({ id: z.number() });\n"),
		);
		const drift = await run(["openapi", "check"], { cwd });

		expect(drift.code).toBe(1);
		expect(drift.stderr).toContain("OPENAPI_DRIFT: GET /users schema changed");
	});
});

/**
 * Creates a minimal Routa project in a temporary directory.
 */
function project(files: Record<string, string>): string {
	const cwd = mkdtempSync(join(tmpdir(), "routa-schema-contracts-"));
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

function schemasFile(body: string): string {
	return `import { z } from "zod";\n\n${body}`;
}

function routeFile(
	path: string,
	contract: { input?: string; responses: string; method?: string; imports?: string },
): string {
	const input = contract.input ? `\t\tinput: { ${contract.input} },\n` : "";
	return `import { createRoute, createRouteRoot } from "@routa-ts/core";
import { z } from "zod";
${contract.imports ?? ""}
export default createRouteRoot(${JSON.stringify(path)})({
\t${contract.method ?? "get"}: createRoute({
${input}\t\tresponses: { ${contract.responses} },
\t\trun: async () => ({ type: "ok", data: {} as never }),
\t}),
});
`;
}

/**
 * Evaluates schema declarations written for a fixture so tests can compare
 * Routa's static projection with Zod's native converter on the same source.
 */
function runtimeSchemas(body: string): Record<string, z.ZodType> {
	const names = Array.from(body.matchAll(/export const (\w+)/g), (match) => match[1]);
	const statements = body.replaceAll("export const", "const");
	return new Function("z", `${statements}\nreturn { ${names.join(", ")} };`)(z) as Record<
		string,
		z.ZodType
	>;
}

function diagnosticsOf(document: unknown): unknown[] {
	return ((document as Json)["x-routa-diagnostics"] as unknown[] | undefined) ?? [];
}

function responseSchema(document: unknown, path: string, method: string, status: number): unknown {
	const operation = (document as { paths: Record<string, Record<string, Json>> }).paths[path][
		method
	];
	const response = (operation.responses as Record<string, Json>)[String(status)];
	return (response.content as Record<string, Json>)["application/json"].schema;
}

/**
 * Normalizes equivalent JSON Schema spellings so a Routa projection and a
 * native Zod conversion compare by meaning.
 *
 * - `$ref`s are inlined from `components`.
 * - `additionalProperties: false` is dropped, because Zod closes output objects
 *   by default and Routa documents response objects as open.
 * - Bare-type `type` arrays become `anyOf`.
 * - `allOf` members that are plain objects fold into one object.
 * - OpenAPI `discriminator` is dropped, because JSON Schema has no equivalent.
 */
function semantic(schema: unknown, components: Record<string, unknown> = {}): unknown {
	if (Array.isArray(schema)) {
		return schema.map((item) => semantic(item, components));
	}

	if (typeof schema !== "object" || schema === null) {
		return schema;
	}

	const { $ref, ...rest } = schema as Json;

	if (typeof $ref === "string") {
		const target = components[$ref.replace(/^#\/(components\/schemas|\$defs)\//, "")];
		return semantic({ ...(target as Json), ...rest }, components);
	}

	let value: Json = {};

	for (const [key, item] of Object.entries(rest)) {
		if (key === "$schema" || key === "$defs" || key === "discriminator") continue;
		if (key === "additionalProperties" && item === false) continue;
		value[key] = semantic(item, components);
	}

	if (Array.isArray(value.type)) {
		const { type, ...others } = value;
		value = { ...others, anyOf: (type as string[]).map((entry) => ({ type: entry })) };
	}

	if (Array.isArray(value.allOf)) {
		value = foldPlainObjects(value);
	}

	if (Array.isArray(value.required)) {
		value.required = [...(value.required as string[])].sort();
	}

	return Object.fromEntries(
		Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
	);
}

/**
 * Converts a runtime schema with Zod's native converter, then normalizes it.
 */
function nativeSchema(schema: z.ZodType, io: "input" | "output" = "output"): unknown {
	const json = z.toJSONSchema(schema, { io }) as Json;
	return semantic(withoutDefaults(json), (json.$defs as Json | undefined) ?? {});
}

/**
 * Rebuilds the object schema that a set of OpenAPI parameters came from.
 */
function parameterObject(parameters: Json[]): Json {
	return {
		type: "object",
		properties: Object.fromEntries(parameters.map((item) => [item.name, item.schema])),
		required: parameters.filter((item) => item.required).map((item) => item.name),
	};
}

/**
 * Drops `default` keywords and integer range bounds, which Zod's converter
 * emits and Routa does not document.
 */
function withoutDefaults(schema: unknown): unknown {
	if (Array.isArray(schema)) return schema.map(withoutDefaults);
	if (typeof schema !== "object" || schema === null) return schema;
	return Object.fromEntries(
		Object.entries(schema)
			.filter(
				([key, value]) =>
					key !== "default"
					&& !(key.endsWith("imum") && Math.abs(value as number) === Number.MAX_SAFE_INTEGER),
			)
			.map(([key, value]) => [key, withoutDefaults(value)]),
	);
}

function foldPlainObjects(value: Json): Json {
	const { allOf, ...others } = value;
	const members = allOf as Json[];
	const foldable = members.every(
		(member) =>
			member.type === "object"
			&& Object.keys(member).every((key) => ["type", "properties", "required"].includes(key)),
	);

	if (!foldable) return value;

	const properties: Json = {};
	const required = new Set<string>();

	for (const member of members) {
		Object.assign(properties, member.properties);
		for (const key of (member.required as string[] | undefined) ?? []) required.add(key);
	}

	return { ...others, type: "object", properties, required: [...required].sort() };
}
