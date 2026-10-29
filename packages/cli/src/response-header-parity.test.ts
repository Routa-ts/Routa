import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHonoApp } from "@routa-ts/core/hono";
import { createLogger } from "@routa-ts/core/logger";
import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { validateProject } from "./project.js";
import { runTypeScript } from "./typescript-runner.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * One header declaration, run through every layer that judges it: TypeScript, `routa check`,
 * app registration, and the three runtime modes. `accepted` is the single expectation all of
 * them must meet.
 */
type Case = {
	name: string;
	/** The Zod expression for the header value, written as it appears in source. */
	schema: string;
	accepted: boolean;
	/** A value the handler writes, as JSON. Required for accepted cases; types defaults to "a". */
	sample?: string;
	/** Whether the header may be left out of the result. */
	optional?: boolean;
	/** TypeScript cannot see this rejection; every other layer still agrees. */
	typesBlind?: true;
};

const cases: Case[] = [
	{ name: "string", schema: "z.string()", accepted: true, sample: '"a"' },
	{ name: "constrained string", schema: "z.string().min(1).max(8)", accepted: true, sample: '"a"' },
	{ name: "integer", schema: "z.number().int()", accepted: true, sample: "3" },
	{ name: "boolean", schema: "z.boolean()", accepted: true, sample: "true" },
	{ name: "string literal", schema: 'z.literal("fixed")', accepted: true, sample: '"fixed"' },
	{ name: "number literal", schema: "z.literal(1)", accepted: true, sample: "1" },
	{ name: "enum", schema: 'z.enum(["a", "b"])', accepted: true, sample: '"a"' },
	{
		name: "union of scalars",
		schema: 'z.union([z.literal("a"), z.literal(1)])',
		accepted: true,
		sample: '"a"',
	},
	{
		name: "refined string",
		schema: "z.string().refine((v) => v.length > 0)",
		accepted: true,
		sample: '"a"',
	},
	{
		name: "optional",
		schema: "z.string().optional()",
		accepted: true,
		sample: '"a"',
		optional: true,
	},
	{ name: "readonly", schema: "z.string().readonly()", accepted: true, sample: '"a"' },
	{
		name: "pipe between non-mutating sides",
		schema: "z.string().pipe(z.email())",
		accepted: true,
		sample: '"a@example.com"',
	},
	{
		name: "optional pipe",
		schema: "z.string().pipe(z.string().min(1)).optional()",
		accepted: true,
		sample: '"a"',
		optional: true,
	},
	{
		name: "intersection of scalars",
		schema: "z.intersection(z.string(), z.string().min(1))",
		accepted: true,
		sample: '"a"',
	},
	{
		name: "nonoptional",
		schema: "z.string().optional().nonoptional()",
		accepted: true,
		sample: '"a"',
	},
	{
		name: "union of a pipe and a literal",
		schema: 'z.union([z.string().pipe(z.email()), z.literal("none")])',
		accepted: true,
		sample: '"none"',
	},
	{ name: "object", schema: "z.object({ a: z.string() })", accepted: false },
	{ name: "array", schema: "z.array(z.string())", accepted: false },
	{ name: "nullable", schema: "z.string().nullable()", accepted: false },
	{ name: "null", schema: "z.null()", accepted: false },
	{ name: "bigint", schema: "z.bigint()", accepted: false },
	{ name: "date", schema: "z.date()", accepted: false },
	{ name: "unknown", schema: "z.unknown()", accepted: false },
	{ name: "transform", schema: "z.string().transform((v) => v.length)", accepted: false },
	{ name: "pipe into a coercion", schema: "z.string().pipe(z.coerce.number())", accepted: false },
	{
		name: "pipe through a transform",
		schema: "z.string().pipe(z.transform((v) => v.length))",
		accepted: false,
	},
	{ name: "coercion", schema: "z.coerce.number()", accepted: false },
	{ name: "default", schema: 'z.string().default("x")', accepted: false },
	{ name: "catch", schema: 'z.string().catch("x")', accepted: false },
	{
		name: "intersection with an object",
		schema: "z.intersection(z.string(), z.object({}))",
		accepted: false,
	},
	{
		name: "template literal",
		schema: 'z.templateLiteral(["v", z.number()])',
		accepted: false,
		sample: '"v1"',
		typesBlind: true,
	},
];

const modes = [
	{ name: "development", options: { runtimeMode: "dev" as const } },
	{
		name: "production by default",
		options: { runtimeMode: "start" as const, responseValidation: "development" as const },
	},
	{
		name: "production with always",
		options: { runtimeMode: "start" as const, responseValidation: "always" as const },
	},
];

const accepted = cases.filter((item) => item.accepted);
const rejected = cases.filter((item) => !item.accepted);

describe("response header declarations agree across layers", () => {
	it("gives TypeScript the verdict every other layer reaches", () => {
		const lines = cases.flatMap((item, index) => {
			const headers = `z.object({ "x-value": ${item.schema} })`;
			const declare = `createRoute({ responses: { ok: { status: 200, headers: ${headers} } }, run: ({ response }) => response.ok(`;
			const written = `{ "x-value": ${item.sample ?? '"a"'} }`;
			const directive = item.accepted || item.typesBlind ? [] : ["// @ts-expect-error"];
			const missing = item.accepted
				? [
						...(item.optional ? [] : ["// @ts-expect-error"]),
						`export const missing${index} = ${declare}{})});`,
					]
				: [];

			return [
				`// ${item.name}`,
				...directive,
				`export const case${index} = ${declare}${written})});`,
				...missing,
			];
		});

		const cwd = mkdtempSync(join(tmpdir(), "routa-header-parity-types-"));
		mkdirSync(join(cwd, "src"), { recursive: true });
		writeFileSync(
			join(cwd, "tsconfig.json"),
			JSON.stringify({
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
				include: ["src/**/*.ts"],
			}),
		);
		const source = `import { createRoute } from "@routa-ts/core";\nimport { z } from "zod";\n\n${lines.join("\n")}\n`;
		writeFileSync(join(cwd, "src/cases.ts"), source);

		const result = runTypeScript(cwd, ["-p", "tsconfig.json", "--noEmit", "--pretty", "false"]);
		const failures = (result.stdout ?? "")
			.split("\n")
			.filter((line) => line.startsWith("src/cases.ts"))
			.map((line) => {
				const row = Number(/\((\d+),/.exec(line)?.[1]);
				const label = source
					.split("\n")
					.slice(0, row)
					.reverse()
					.find((text) => text.startsWith("// ") && !text.startsWith("// @ts"));
				return `${label}: ${line.replace(/^src\/cases\.ts\(\d+,\d+\): /, "")}`;
			});

		expect(failures).toEqual([]);
	});

	it("gives routa check the verdict every other layer reaches", () => {
		const files: Record<string, string> = {
			"package.json": JSON.stringify({ type: "module" }),
			"tsconfig.json": "{}",
			"src/routa.ts":
				'import { createRouta } from "@routa-ts/core";\n\nexport default createRouta({});\n',
			".routa/.keep": "",
		};

		cases.forEach((item, index) => {
			files[`src/routes/case${index}/route.ts`] =
				`import { createRoute, createRouteRoot } from "@routa-ts/core";
import { z } from "zod";

export default createRouteRoot("/case${index}")({
\tget: createRoute({
\t\tresponses: { ok: { status: 200, headers: z.object({ "x-value": ${item.schema} }) } },
\t\trun: () => ({ type: "ok", headers: {} as never }),
\t}),
});
`;
		});

		const cwd = mkdtempSync(join(tmpdir(), "routa-header-parity-check-"));

		for (const [file, content] of Object.entries(files)) {
			mkdirSync(dirname(join(cwd, file)), { recursive: true });
			writeFileSync(join(cwd, file), content);
		}

		const reported = new Set(
			validateProject(cwd, { write: false }).diagnostics.map(
				(diagnostic) => /case(\d+)\//.exec(diagnostic.file ?? "")?.[1],
			),
		);
		const verdicts = cases.map((item, index) => ({
			name: item.name,
			accepted: !reported.has(String(index)),
		}));

		expect(verdicts).toEqual(cases.map((item) => ({ name: item.name, accepted: item.accepted })));
	});

	it.each(accepted.map((item) => [item.name, item] as const))(
		"registers %s and sends it in every runtime mode",
		async (_name, item) => {
			const schema = evaluate(item.schema);
			const value = JSON.parse(item.sample as string) as string | number | boolean;

			for (const mode of modes) {
				const sent = await respond(schema, { "x-value": value }, mode.options);
				expect(sent.status, mode.name).toBe(200);
				expect(sent.headers.get("x-value"), mode.name).toBe(String(value));

				const left = await respond(schema, {}, mode.options);
				expect(left.status, `${mode.name}: header left out`).toBe(item.optional ? 200 : 500);
				expect(left.headers.has("x-value"), `${mode.name}: header left out`).toBe(false);
			}
		},
	);

	it.each(rejected.map((item) => [item.name, item] as const))(
		"refuses %s when the app registers the route",
		(_name, item) => {
			expect(() => registered(evaluate(item.schema), {}, modes[0].options)).toThrow(/x-value/);
		},
	);
});

function evaluate(source: string): z.ZodType {
	return new Function("z", `return ${source};`)(z) as z.ZodType;
}

function registered(schema: z.ZodType, written: Record<string, unknown>, options: object) {
	return createHonoApp(
		[
			{
				method: "get",
				path: "/item",
				// Hand-built, so declarations TypeScript would reject still reach registration.
				contract: {
					responses: { ok: { status: 200, headers: z.object({ "x-value": schema }) } },
					run: () => ({ type: "ok", headers: written }),
				} as never,
			},
		],
		{ ...options, logger: createLogger({ sink: () => undefined }) },
	);
}

async function respond(schema: z.ZodType, written: Record<string, unknown>, options: object) {
	return registered(schema, written, options).request("/item");
}
