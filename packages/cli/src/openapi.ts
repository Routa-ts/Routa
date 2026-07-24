import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isBodylessStatus } from "@routa-ts/core/hono";
import {
	callName,
	localInitializer,
	objectLiteral,
	propertyName,
	unwrapExpression,
} from "./ast.js";
import { type MiddlewareMetadata, validateProject } from "./project.js";
import * as ts from "./typescript.js";

type OpenApiLike = {
	openapi?: string;
	info?: unknown;
	paths?: Record<
		string,
		Record<
			string,
			{
				operationId?: string;
				security?: unknown;
				parameters?: Array<Record<string, unknown>>;
				requestBody?: Record<string, unknown>;
				responses?: Record<string, unknown>;
			}
		>
	>;
	components?: {
		schemas?: Record<string, unknown>;
	};
};

/**
 * Checks the generated OpenAPI document against the saved baseline.
 *
 * @returns An object with an exit code and either standard output on success or standard error on failure.
 */
export function runOpenApiCheck(cwd = process.cwd()): {
	code: number;
	stdout?: string;
	stderr?: string;
} {
	const baseline = readBaseline(cwd);

	if (!baseline) {
		return { code: 1, stderr: "Missing .routa/openapi-baseline.json. Run routa scaffold first.\n" };
	}

	const current = generateOpenApi(cwd);
	const invalidGraph = invalidGraphDiagnostics(current);

	if (invalidGraph.length > 0) {
		return { code: 1, stderr: `${invalidGraph.join("\n")}\n` };
	}

	const diagnostics = driftDiagnostics(baseline, current);

	if (diagnostics.length > 0) {
		return { code: 1, stderr: `${diagnostics.join("\n")}\n` };
	}

	return { code: 0, stdout: "OpenAPI check passed. No drift detected.\n" };
}

/**
 * Checks for removed OpenAPI operations against the baseline.
 *
 * Writes the generated OpenAPI document back to the baseline file when `--update-baseline` is present.
 *
 * @param argv - Command-line arguments
 * @param cwd - The working directory containing the Routa project
 * @returns An exit result with diagnostics or a success message
 */
export function runOpenApiBreaking(
	argv: readonly string[],
	cwd = process.cwd(),
): { code: number; stdout?: string; stderr?: string } {
	const baseline = readBaseline(cwd);

	if (!baseline) {
		return { code: 1, stderr: "Missing .routa/openapi-baseline.json. Run routa scaffold first.\n" };
	}

	const current = generateOpenApi(cwd);
	const invalidGraph = invalidGraphDiagnostics(current);

	if (invalidGraph.length > 0) {
		return { code: 1, stderr: `${invalidGraph.join("\n")}\n` };
	}

	const diagnostics = breakingChangeDiagnostics(baseline, current);

	if (argv.includes("--update-baseline")) {
		writeFileSync(
			join(cwd, ".routa/openapi-baseline.json"),
			`${JSON.stringify(current, null, "\t")}\n`,
		);
		return { code: 0, stdout: "OpenAPI baseline updated.\n" };
	}

	if (diagnostics.length > 0) {
		return {
			code: 1,
			stderr: `${diagnostics.join("\n")}\nRun routa openapi breaking --update-baseline to accept the current contract as the new baseline.\n`,
		};
	}

	return { code: 0, stdout: "OpenAPI breaking check passed. No breaking changes detected.\n" };
}

/**
 * Builds an OpenAPI document for the current project.
 *
 * @param cwd - The project directory to inspect.
 * @returns The generated OpenAPI document, including diagnostics when project validation fails.
 */
export function generateOpenApi(cwd = process.cwd()): OpenApiLike {
	return ts.withSourceFileParsing(cwd, (parser) => generateOpenApiInSession(cwd, parser));
}

function generateOpenApiInSession(cwd: string, parser: ts.SourceFileParser): OpenApiLike {
	const validation = validateProject(cwd, { write: false }, parser);
	const baseline = readBaseline(cwd);
	const paths: NonNullable<OpenApiLike["paths"]> = {};
	const components = baseline?.components;
	const schemaWarnings: string[] = [];

	if (validation.diagnostics.length > 0) {
		return {
			openapi: "3.1.0",
			info: baseline?.info ?? { title: "Routa API", version: "0.0.0" },
			paths,
			...(components ? { components } : {}),
			"x-routa-diagnostics": validation.diagnostics.map((diagnostic) => ({
				code: diagnostic.code,
				message: diagnostic.message,
				file: diagnostic.file,
			})),
		} as OpenApiLike;
	}

	for (const route of validation.routes) {
		const { contracts, warnings } = readRouteContracts(
			cwd,
			route.file,
			components?.schemas ?? {},
			parser,
		);
		schemaWarnings.push(...warnings.map((message) => `${route.file}: ${message}`));
		const openApiPath = route.path.replaceAll(/:([^/]+)/g, "{$1}");
		paths[openApiPath] = Object.fromEntries(
			Object.entries(route.responses).map(([method, statuses]) => {
				const baselineOperation = baseline?.paths?.[openApiPath]?.[method];
				const input = operationInput(route.path, contracts[method]?.input, baselineOperation);
				const middleware = route.methodMiddleware[method] ?? route.middleware;

				const responseSchemas = new Map([
					...middlewareRejectSchemas(
						middleware,
						components?.schemas ?? {},
						parser,
						join(".routa", "middleware-rejects", route.file, method),
					),
					...(contracts[method]?.responses ?? new Map()),
				]);

				return [
					method,
					{
						...operationMetadataForBaseline(baselineOperation),
						...middlewareOpenApiMetadata(middleware),
						...deprecationMetadata(contracts[method]?.deprecation),
						...input,
						responses: operationResponses(statuses, responseSchemas, baselineOperation),
					},
				];
			}),
		);
	}

	return {
		openapi: "3.1.0",
		info: baseline?.info ?? { title: "Routa API", version: "0.0.0" },
		paths,
		...(components ? { components } : {}),
		...(schemaWarnings.length > 0
			? {
					"x-routa-schema-warnings": schemaWarnings.map((message) => ({
						code: "ROUTA_OPENAPI_UNSUPPORTED_ZOD",
						message,
					})),
				}
			: {}),
	};
}

function middlewareOpenApiMetadata(
	middleware: readonly MiddlewareMetadata[],
): Record<string, unknown> {
	const security = middleware.flatMap((item) => item.security);
	const permissions = Array.from(new Set(middleware.flatMap((item) => item.permissions))).sort();
	return {
		...(security.length > 0 ? { security } : {}),
		...(permissions.length > 0 ? { "x-routa-authz": permissions } : {}),
	};
}

function deprecationMetadata(deprecation: ParsedContract["deprecation"]): Record<string, unknown> {
	if (!deprecation) return {};
	return {
		deprecated: true,
		...(deprecation.sunset ? { "x-routa-sunset": deprecation.sunset } : {}),
		...(deprecation.replacement ? { "x-routa-replacement": deprecation.replacement } : {}),
	};
}

/**
 * Looks up baseline operation metadata that generated route code does not yet model.
 *
 * @param operation - The baseline OpenAPI operation to read from.
 * @returns Operation metadata that should survive regeneration.
 */
function operationMetadataForBaseline(
	operation: NonNullable<OpenApiLike["paths"]>[string][string] | undefined,
): Record<string, unknown> {
	return {
		...(operation?.operationId ? { operationId: operation.operationId } : {}),
		...("security" in (operation ?? {})
			? { security: (operation as { security?: unknown }).security }
			: {}),
	};
}

/**
 * Builds OpenAPI responses for a route operation while preserving baseline-only responses.
 *
 * @param statuses - The response statuses discovered from route code.
 * @param schemas - The response schemas discovered from route code.
 * @param baselineOperation - The matching baseline operation, when one exists.
 * @returns OpenAPI response entries for the operation.
 */
function operationResponses(
	statuses: number[],
	schemas: Map<number, unknown> | undefined,
	baselineOperation: NonNullable<OpenApiLike["paths"]>[string][string] | undefined,
): Record<string, unknown> {
	const responses: Record<string, unknown> = Object.fromEntries(
		statuses.map((status) => [
			String(status),
			isBodylessStatus(status)
				? {
						description: "Generated by Routa",
					}
				: {
						description: "Generated by Routa",
						content: {
							"application/json": {
								schema: schemas?.get(status) ?? { type: "object" },
							},
						},
					},
		]),
	);

	for (const [status, response] of Object.entries(baselineOperation?.responses ?? {})) {
		if (!(status in responses)) {
			responses[status] = response;
		}
	}

	return responses;
}

/**
 * Formats Routa graph diagnostics from an OpenAPI document.
 *
 * @returns The diagnostics as formatted strings.
 */
function invalidGraphDiagnostics(document: OpenApiLike): string[] {
	const diagnostics = (
		document as { "x-routa-diagnostics"?: Array<{ code: string; message: string; file?: string }> }
	)["x-routa-diagnostics"];

	return (diagnostics ?? []).map((diagnostic) => {
		const location = diagnostic.file ? `${diagnostic.file}: ` : "";
		return `${diagnostic.code}: ${location}${diagnostic.message}`;
	});
}

type ParsedContract = {
	input: Partial<Record<"params" | "query" | "headers" | "cookies" | "body", unknown>>;
	responses: Map<number, unknown>;
	deprecation?: { sunset?: string; replacement?: string };
};

/**
 * Builds OpenAPI input for a route.
 *
 * @param path - The route path containing `:param` segments.
 * @param input - The parsed contract input for the route.
 * @returns An object containing OpenAPI `parameters` and, when present, a JSON `requestBody`.
 */
function operationInput(
	path: string,
	input: ParsedContract["input"] | undefined,
	baselineOperation?: NonNullable<OpenApiLike["paths"]>[string][string],
) {
	const parameters = [
		...pathParams(path).map((name) => ({
			name,
			in: "path",
			required: true,
			schema: input?.params ? propertySchema(input.params, name) : { type: "string" },
		})),
		...parameterSchemas(input?.query, "query"),
		...parameterSchemas(input?.headers, "header"),
		...parameterSchemas(input?.cookies, "cookie"),
	];

	return {
		...(parameters.length > 0 ? { parameters } : {}),
		...(input?.body
			? {
					requestBody: {
						...requestBodyMetadata(input.body, baselineOperation?.requestBody),
						content: {
							"application/json": {
								schema: input.body,
							},
						},
					},
				}
			: {}),
	};
}

/**
 * Builds request body metadata from route code, falling back to the baseline when needed.
 *
 * @param body - The parsed route body contract.
 * @param requestBody - The baseline request body to read from.
 * @returns Request body metadata that should survive regeneration.
 */
function requestBodyMetadata(
	body: unknown,
	requestBody: Record<string, unknown> | undefined,
): Record<string, unknown> {
	if (body) {
		return { required: true };
	}

	return "required" in (requestBody ?? {}) ? { required: requestBody?.required } : {};
}

/**
 * Reads request and response contracts from a route file.
 *
 * @param cwd - The working directory containing the route file
 * @param routeFile - The route file path relative to `cwd`
 * @param components - Available component schemas for resolving references
 * @returns A record of HTTP methods to parsed route contracts
 */
function readRouteContracts(
	cwd: string,
	routeFile: string,
	components: Record<string, unknown>,
	parser: ts.SourceFileParser,
): { contracts: Record<string, ParsedContract>; warnings: string[] } {
	const routePath = join(cwd, routeFile);
	const routeSource = readFileSync(routePath, "utf8");
	const routeAst = parser.createSourceFile(routePath, routeSource);
	const schemaFile = join(dirname(routePath), "schemas.ts");
	const schemas = existsSync(schemaFile)
		? readSchemaExports(schemaFile, components, parser)
		: new SchemaReader("", components, parser, schemaFile);
	const contracts: Record<string, ParsedContract> = {};

	for (const routeProperty of routeConfigProperties(routeAst)) {
		const method = propertyName(routeProperty.name);

		if (!method || !isHttpMethod(method)) {
			continue;
		}

		const createRouteArg = createRouteConfig(routeProperty.initializer);

		if (!createRouteArg) {
			continue;
		}

		contracts[method] = {
			input: readInputSchemas(createRouteArg, schemas),
			responses: readResponseSchemas(createRouteArg, schemas),
			deprecation: readDeprecation(createRouteArg),
		};
	}

	return { contracts, warnings: schemas.warnings };
}

function readDeprecation(contract: ts.ObjectLiteralExpression): ParsedContract["deprecation"] {
	const property = objectProperty(contract, "deprecation");
	const value = objectLiteral(property);
	if (!value) return undefined;
	const string = (name: string) => {
		const item = objectProperty(value, name);
		const expression = item && unwrapExpression(item);
		return expression && ts.isStringLiteralLike(expression) ? expression.text : undefined;
	};
	const sunset = string("sunset");
	const replacement = string("replacement");
	return sunset || replacement ? { sunset, replacement } : undefined;
}

function middlewareRejectSchemas(
	middleware: readonly MiddlewareMetadata[],
	components: Record<string, unknown>,
	parser: ts.SourceFileParser,
	virtualRoot: string,
): Map<number, unknown> {
	const schemas = new Map<number, unknown>();
	let snippetIndex = 0;

	for (const item of middleware) {
		for (const reject of item.rejects) {
			const virtualFile = join(virtualRoot, `${snippetIndex++}.ts`);
			schemas.set(
				reject.status,
				schemaFromExpressionText(reject.schema, components, parser, virtualFile),
			);
		}
	}

	return schemas;
}

function schemaFromExpressionText(
	expressionText: string,
	components: Record<string, unknown>,
	parser: ts.SourceFileParser,
	virtualFile: string,
): unknown {
	const source = parser.createSourceFile(virtualFile, `const schema = ${expressionText};`);
	const declaration = source.statements.find(ts.isVariableStatement)?.declarationList
		.declarations[0];

	return declaration?.initializer
		? new SchemaReader("", components, parser, virtualFile).expressionSchema(
				declaration.initializer,
			)
		: {};
}

class SchemaReader {
	private readonly ast?: ts.SourceFile;
	private readonly exports = new Map<string, ts.Expression>();
	readonly warnings: string[] = [];

	constructor(
		source: string,
		private readonly components: Record<string, unknown>,
		private readonly parser: ts.SourceFileParser,
		fileName: string,
	) {
		if (!source) {
			return;
		}

		this.ast = this.parser.createSourceFile(fileName, source);

		for (const statement of this.ast.statements) {
			if (!ts.isVariableStatement(statement)) {
				continue;
			}

			if (!statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
				continue;
			}

			for (const declaration of statement.declarationList.declarations) {
				if (ts.isIdentifier(declaration.name) && declaration.initializer) {
					this.exports.set(declaration.name.text, declaration.initializer);
				}
			}
		}
	}

	schema(name: string): unknown {
		return this.schemaForName(name, new Set());
	}

	expressionSchema(expression: ts.Expression): unknown {
		return this.schemaForExpression(expression, new Set());
	}

	private warnUnknown(expression: ts.Expression, detail: string): void {
		const text = expression.getText(expression.getSourceFile()).slice(0, 80);
		const message = `Unsupported Zod construct for OpenAPI (${detail}): ${text}`;

		if (!this.warnings.includes(message)) {
			this.warnings.push(message);
		}
	}

	private schemaForName(name: string, seen: Set<string>): unknown {
		if (this.components[name]) {
			return { $ref: `#/components/schemas/${name}` };
		}

		if (seen.has(name)) {
			return {};
		}

		const expression = this.exports.get(name);

		if (!expression) {
			const message = `Could not resolve schema export ${name} for OpenAPI generation.`;
			if (!this.warnings.includes(message)) {
				this.warnings.push(message);
			}
			return {};
		}

		seen.add(name);
		return this.schemaForExpression(expression, seen);
	}

	private schemaForExpression(expression: ts.Expression, seen: Set<string>): unknown {
		const unwrapped = unwrapExpression(expression);

		if (ts.isIdentifier(unwrapped)) {
			return this.schemaForName(unwrapped.text, seen);
		}

		if (!ts.isCallExpression(unwrapped)) {
			this.warnUnknown(unwrapped, "expected a Zod call expression");
			return {};
		}

		const call = callName(unwrapped.expression);

		if (call === "optional") {
			return ts.isPropertyAccessExpression(unwrapped.expression)
				? this.schemaForExpression(unwrapped.expression.expression, seen)
				: {};
		}

		if (passthroughCalls.has(call ?? "")) {
			return ts.isPropertyAccessExpression(unwrapped.expression)
				? this.schemaForExpression(unwrapped.expression.expression, seen)
				: {};
		}

		if (call === "nullable" || call === "nullish") {
			const inner = ts.isPropertyAccessExpression(unwrapped.expression)
				? this.schemaForExpression(unwrapped.expression.expression, seen)
				: {};
			return { anyOf: [inner, { type: "null" }] };
		}

		if (call === "array") {
			return { type: "array", items: this.schemaForExpression(unwrapped.arguments[0], seen) };
		}

		if (call === "string") {
			return { type: "string" };
		}

		if (call === "enum" && ts.isArrayLiteralExpression(unwrapped.arguments[0])) {
			const values = unwrapped.arguments[0].elements.flatMap((element) => {
				const value = unwrapExpression(element);
				return ts.isStringLiteralLike(value) ? [value.text] : [];
			});

			return { type: "string", enum: values };
		}

		if (call === "literal") {
			const value = literalValue(unwrapped.arguments[0]);
			if (value === undefined) {
				this.warnUnknown(unwrapped, "unsupported z.literal argument");
				return {};
			}
			return { type: typeof value, const: value };
		}

		if (call === "union" && ts.isArrayLiteralExpression(unwrapped.arguments[0])) {
			return {
				anyOf: unwrapped.arguments[0].elements.map((element) =>
					this.schemaForExpression(element as ts.Expression, seen),
				),
			};
		}

		if (call === "discriminatedUnion" && ts.isArrayLiteralExpression(unwrapped.arguments[1])) {
			return {
				anyOf: unwrapped.arguments[1].elements.map((element) =>
					this.schemaForExpression(element as ts.Expression, seen),
				),
			};
		}

		if (call === "record") {
			const valueSchema = unwrapped.arguments[unwrapped.arguments.length - 1];
			return {
				type: "object",
				additionalProperties: valueSchema ? this.schemaForExpression(valueSchema, seen) : {},
			};
		}

		if (call === "int") {
			return { type: "integer" };
		}

		if (call === "number") {
			return { type: "number" };
		}

		if (call === "boolean" || call === "stringbool") {
			return { type: "boolean" };
		}

		if (call === "null") {
			return { type: "null" };
		}

		if (call === "date") {
			// `z.iso.date()` and `z.date()` both resolve to `call === "date"` via `callName`,
			// so we need to inspect the full call expression to disambiguate.
			const expr = unwrapped.expression;
			const isIsoDate =
				ts.isPropertyAccessExpression(expr)
				&& ts.isPropertyAccessExpression(expr.expression)
				&& expr.expression.name.text === "iso";

			return isIsoDate ? { type: "string", format: stringFormatCalls.date } : { type: "string" };
		}

		if (call && Object.hasOwn(stringFormatCalls, call)) {
			return { type: "string", format: stringFormatCalls[call] };
		}

		if (call === "unknown" || call === "any") {
			return {};
		}

		if (call !== "object" || !ts.isObjectLiteralExpression(unwrapped.arguments[0])) {
			this.warnUnknown(unwrapped, call ? `unsupported Zod call "${call}"` : "unknown Zod call");
			return {};
		}

		const properties: Record<string, unknown> = {};
		const required: string[] = [];

		for (const property of unwrapped.arguments[0].properties) {
			if (!ts.isPropertyAssignment(property)) {
				continue;
			}

			const name = propertyName(property.name);

			if (!name || !ts.isExpression(property.initializer)) {
				continue;
			}

			const optional = isOptionalCall(property.initializer);
			properties[name] = this.schemaForExpression(property.initializer, seen);

			if (!optional) {
				required.push(name);
			}
		}

		return {
			type: "object",
			...(required.length > 0 ? { required } : {}),
			properties,
		};
	}
}

/**
 * Zod method calls that refine a schema without changing its OpenAPI type.
 */
const passthroughCalls = new Set([
	"min",
	"max",
	"positive",
	"nonnegative",
	"negative",
	"nonpositive",
	"default",
	"describe",
	"regex",
	"trim",
	"length",
	"startsWith",
	"endsWith",
	"nonempty",
	"lowercase",
	"uppercase",
	"toLowerCase",
	"toUpperCase",
	"catch",
	"readonly",
	"meta",
	"brand",
	"multipleOf",
]);

/**
 * Zod string factory calls mapped to their OpenAPI string formats.
 */
const stringFormatCalls: Record<string, string> = {
	email: "email",
	uuid: "uuid",
	url: "uri",
	datetime: "date-time",
	date: "date",
};

/**
 * Reads a literal value from a `z.literal(...)` argument.
 *
 * @param expression - The literal argument expression
 * @returns The literal string, number, or boolean, or `undefined` when unsupported
 */
function literalValue(
	expression: ts.Expression | undefined,
): string | number | boolean | undefined {
	if (!expression) {
		return undefined;
	}

	const unwrapped = unwrapExpression(expression);

	if (ts.isStringLiteralLike(unwrapped)) {
		return unwrapped.text;
	}

	if (ts.isNumericLiteral(unwrapped)) {
		return Number(unwrapped.text);
	}

	if (
		ts.isPrefixUnaryExpression(unwrapped)
		&& unwrapped.operator === ts.SyntaxKind.MinusToken
		&& ts.isNumericLiteral(unwrapped.operand)
	) {
		return -Number(unwrapped.operand.text);
	}

	if (unwrapped.kind === ts.SyntaxKind.TrueKeyword) {
		return true;
	}

	if (unwrapped.kind === ts.SyntaxKind.FalseKeyword) {
		return false;
	}

	return undefined;
}

/**
 * Creates a schema reader for exported schema definitions in a file.
 *
 * @param schemaFile - Path to the TypeScript file containing schema exports
 * @param components - Component schemas available for `$ref` resolution
 * @returns A schema reader initialized with the file contents
 */
function readSchemaExports(
	schemaFile: string,
	components: Record<string, unknown>,
	parser: ts.SourceFileParser,
): SchemaReader {
	return new SchemaReader(readFileSync(schemaFile, "utf8"), components, parser, schemaFile);
}

/**
 * Collects HTTP method property assignments from `createRouteRoot` route config
 * object literals (same call shapes `project.ts` walks).
 *
 * @param ast - The source file to scan
 * @returns The property assignments found on matching route config objects
 */
function routeConfigProperties(ast: ts.SourceFile): ts.PropertyAssignment[] {
	const properties: ts.PropertyAssignment[] = [];

	function collectFromConfig(config: ts.ObjectLiteralExpression): void {
		for (const property of config.properties) {
			if (ts.isPropertyAssignment(property)) {
				properties.push(property);
			}
		}
	}

	function isRouteConfigCall(node: ts.CallExpression): boolean {
		const callee = unwrapExpression(node.expression);

		// Inline `createRouteRoot("/path")({ ... })`
		if (ts.isCallExpression(callee) && callName(callee.expression) === "createRouteRoot") {
			return true;
		}

		// `const route = createRouteRoot("/path"); export default route({ ... })`
		if (ts.isIdentifier(callee)) {
			const initializer = localInitializer(ast, callee.text);

			if (initializer) {
				const unwrapped = unwrapExpression(initializer);
				return (
					ts.isCallExpression(unwrapped) && callName(unwrapped.expression) === "createRouteRoot"
				);
			}
		}

		return false;
	}

	function visit(node: ts.Node): void {
		if (
			ts.isCallExpression(node)
			&& node.arguments.length > 0
			&& ts.isObjectLiteralExpression(node.arguments[0])
			&& isRouteConfigCall(node)
		) {
			collectFromConfig(node.arguments[0]);
		}

		ts.forEachChild(node, visit);
	}

	visit(ast);

	// Also accept bare `export default { get: createRoute(...) }` like project.ts.
	if (properties.length === 0) {
		for (const statement of ast.statements) {
			if (!ts.isExportAssignment(statement) || statement.isExportEquals) {
				continue;
			}

			const expression = unwrapExpression(statement.expression);
			const resolved = ts.isIdentifier(expression)
				? localInitializer(ast, expression.text)
				: expression;
			const config = resolved ? unwrapExpression(resolved) : undefined;

			if (config && ts.isObjectLiteralExpression(config)) {
				collectFromConfig(config);
			} else if (config && ts.isCallExpression(config) && isRouteConfigCall(config)) {
				const arg = config.arguments[0];
				if (arg && ts.isObjectLiteralExpression(arg)) {
					collectFromConfig(arg);
				}
			}
		}
	}

	return properties;
}

/**
 * Finds the initializer for a top-level `const`/`let`/`var` binding.
 */
/**
 * Extracts the route configuration object from a `createRoute` call.
 *
 * @param expression - The expression to inspect
 * @returns The object literal passed to `createRoute`, or `undefined` if the expression is not a matching call
 */
function createRouteConfig(expression: ts.Expression): ts.ObjectLiteralExpression | undefined {
	const unwrapped = unwrapExpression(expression);

	if (
		ts.isCallExpression(unwrapped)
		&& callName(unwrapped.expression) === "createRoute"
		&& ts.isObjectLiteralExpression(unwrapped.arguments[0])
	) {
		return unwrapped.arguments[0];
	}

	return undefined;
}

/**
 * Reads input schema definitions from a route configuration.
 *
 * @param config - The route configuration object.
 * @param schemas - The schema resolver used to convert TypeScript expressions into schema objects.
 * @returns A mapping of input field names to resolved schema objects.
 */
function readInputSchemas(
	config: ts.ObjectLiteralExpression,
	schemas: SchemaReader,
): ParsedContract["input"] {
	const input = objectProperty(config, "input");

	if (!input || !ts.isObjectLiteralExpression(input)) {
		return {};
	}

	return Object.fromEntries(
		input.properties.flatMap((property) => {
			if (!ts.isPropertyAssignment(property)) {
				return [];
			}

			const name = propertyName(property.name);

			return name ? [[name, schemas.expressionSchema(property.initializer)]] : [];
		}),
	) as ParsedContract["input"];
}

/**
 * Reads response schemas from a route configuration.
 *
 * @param config - The route configuration object.
 * @param schemas - The schema resolver used to convert expressions into OpenAPI schemas.
 * @returns A map of HTTP status codes to resolved response schemas.
 */
function readResponseSchemas(
	config: ts.ObjectLiteralExpression,
	schemas: SchemaReader,
): Map<number, unknown> {
	const responses = objectProperty(config, "responses");
	const result = new Map<number, unknown>();

	if (!responses || !ts.isObjectLiteralExpression(responses)) {
		return result;
	}

	for (const response of responses.properties) {
		if (!ts.isPropertyAssignment(response) || !ts.isObjectLiteralExpression(response.initializer)) {
			continue;
		}

		const status = numericProperty(response.initializer, "status");
		const schema = objectProperty(response.initializer, "schema");

		if (status && schema) {
			result.set(status, schemas.expressionSchema(schema));
		}
	}

	return result;
}

/**
 * Gets the initializer for a named property in an object literal.
 *
 * @param object - The object literal to search
 * @param name - The property name to match
 * @returns The matching property's initializer, or `undefined` if no match is found
 */
function objectProperty(
	object: ts.ObjectLiteralExpression,
	name: string,
): ts.Expression | undefined {
	for (const property of object.properties) {
		if (ts.isPropertyAssignment(property) && propertyName(property.name) === name) {
			return property.initializer;
		}
	}

	return undefined;
}

/**
 * Gets a numeric property value from an object literal.
 *
 * @param object - The object literal to read from.
 * @param name - The property name.
 * @returns The numeric value when the property exists and is a numeric literal; otherwise, `undefined`.
 */
function numericProperty(object: ts.ObjectLiteralExpression, name: string): number | undefined {
	const value = objectProperty(object, name);

	if (value && ts.isNumericLiteral(value)) {
		return Number(value.text);
	}

	return undefined;
}

/**
 * Gets the text of a property name node.
 *
 * @param name - The property name node to read.
 * @returns The property name text, or `undefined` for unsupported name nodes.
 */
/**
 * Gets the name of a callable expression.
 *
 * @returns The identifier or property name for the expression, or `undefined` if no name can be resolved.
 */
/**
 * Determines whether an expression calls `optional`.
 *
 * @param expression - The expression to inspect
 * @returns `true` if the expression is an `optional(...)` call, `false` otherwise.
 */
function isOptionalCall(expression: ts.Expression): boolean {
	const unwrapped = unwrapExpression(expression);
	if (!ts.isCallExpression(unwrapped)) {
		return false;
	}

	const call = callName(unwrapped.expression);
	return call === "optional" || call === "nullish";
}

/**
 * Determines whether a value is an HTTP method name.
 *
 * @param value - The value to check
 * @returns `true` if `value` is an application-owned Routa method, `false` otherwise.
 */
function isHttpMethod(value: string): boolean {
	return ["get", "post", "put", "patch", "delete", "head"].includes(value);
}

/**
 * Removes wrapper expressions and returns the inner expression.
 *
 * @param expression - The expression to unwrap
 * @returns The innermost expression after removing wrapper syntax
 */
/**
 * Builds OpenAPI parameter definitions from an object schema.
 *
 * @param schema - The schema whose properties become parameters.
 * @param location - The OpenAPI parameter location.
 * @returns The parameter definitions for each property in `schema`.
 */
function parameterSchemas(schema: unknown, location: string): Array<Record<string, unknown>> {
	if (!isObjectSchema(schema)) {
		return [];
	}

	return Object.entries(schema.properties ?? {}).map(([name, value]) => ({
		name,
		in: location,
		required: Array.isArray(schema.required) ? schema.required.includes(name) : false,
		schema: value,
	}));
}

/**
 * Gets the schema for a named object property.
 *
 * @param schema - The object schema to read from
 * @param name - The property name
 * @returns The property's schema, or `{ type: "string" }` when no schema is defined
 */
function propertySchema(schema: unknown, name: string): unknown {
	if (!isObjectSchema(schema)) {
		return { type: "string" };
	}

	return schema.properties?.[name] ?? { type: "string" };
}

/**
 * Determines whether a value is an object schema.
 *
 * @param value - The value to check.
 * @returns `true` if the value is a non-null object, `false` otherwise.
 */
function isObjectSchema(value: unknown): value is {
	type?: string;
	properties?: Record<string, unknown>;
	required?: string[];
} {
	return typeof value === "object" && value !== null;
}

/**
 * Extracts parameter names from a route path.
 *
 * @returns The parameter names found in `:name` segments.
 */
function pathParams(path: string): string[] {
	return Array.from(path.matchAll(/:([^/]+)/g)).map((match) => match[1]);
}

/**
 * Compares two OpenAPI documents and reports drift between them.
 *
 * @returns Diagnostic strings for removed operations, removed response statuses, schema changes, and added response statuses.
 */
function driftDiagnostics(baseline: OpenApiLike, current: OpenApiLike): string[] {
	const diagnostics: string[] = [];

	for (const [path, methods] of Object.entries(baseline.paths ?? {})) {
		for (const [method, operation] of Object.entries(methods)) {
			const currentOperation = current.paths?.[path]?.[method];

			if (!currentOperation) {
				diagnostics.push(`OPENAPI_DRIFT: ${method.toUpperCase()} ${path} removed`);
				continue;
			}

			for (const status of Object.keys(operation.responses ?? {})) {
				if (!(status in (currentOperation.responses ?? {}))) {
					diagnostics.push(
						`OPENAPI_DRIFT: ${method.toUpperCase()} ${path} response ${status} removed`,
					);
				}
			}

			const baselineComparable = comparableOperation(operation);
			const currentComparable = comparableOperation(currentOperation);

			if (stableJson(baselineComparable) !== stableJson(currentComparable)) {
				diagnostics.push(`OPENAPI_DRIFT: ${method.toUpperCase()} ${path} schema changed`);
			}
		}
	}

	for (const [path, methods] of Object.entries(current.paths ?? {})) {
		for (const [method, operation] of Object.entries(methods)) {
			const baselineOperation = baseline.paths?.[path]?.[method];

			if (!baselineOperation) {
				diagnostics.push(`OPENAPI_DRIFT: ${method.toUpperCase()} ${path} added`);
				continue;
			}

			const baselineResponses = baselineOperation.responses ?? {};
			const currentStatuses = Object.keys(operation.responses ?? {});

			for (const status of currentStatuses) {
				if (!(status in baselineResponses)) {
					diagnostics.push(`OPENAPI_DRIFT: ${method.toUpperCase()} ${path} response ${status}`);
				}
			}
		}
	}

	return diagnostics;
}

/**
 * Normalizes an operation for stable comparison.
 *
 * @returns A normalized object containing the operation's parameters, request body, and responses.
 */
function comparableOperation(operation: {
	parameters?: Array<Record<string, unknown>>;
	requestBody?: Record<string, unknown>;
	responses?: Record<string, unknown>;
}) {
	return {
		parameters: normalize((operation.parameters ?? []).map(comparableParameter)),
		requestBody: normalizeRequestBody(operation.requestBody),
		responses: normalize(operation.responses ?? {}),
	};
}

/**
 * Normalizes a parameter for comparison.
 *
 * Header names are case-insensitive in HTTP and generated source uses lowercase
 * names, so header parameters compare by lowercase name.
 */
function comparableParameter(parameter: Record<string, unknown>): Record<string, unknown> {
	if (parameter.in === "header" && typeof parameter.name === "string") {
		return { ...parameter, name: parameter.name.toLowerCase() };
	}

	return parameter;
}

/**
 * Normalizes a request body for comparison.
 *
 * @param requestBody - The request body to normalize.
 * @returns The normalized request body without the `required` field.
 */
function normalizeRequestBody(requestBody: Record<string, unknown> | undefined): unknown {
	if (!requestBody) {
		return normalize(requestBody);
	}

	const { required: _required, ...rest } = requestBody;
	return normalize(rest);
}

/**
 * Normalizes a value for stable JSON comparison.
 */
function normalize(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value
			.map(normalize)
			.sort((left, right) => stableJson(left).localeCompare(stableJson(right)));
	}

	if (typeof value === "object" && value !== null) {
		return Object.fromEntries(
			Object.entries(canonicalizeSchema(value as Record<string, unknown>))
				.filter(([, item]) => !isEmptySchemaContainer(item))
				.filter(([key]) => key !== "description")
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, item]) => [key, normalize(item)]),
		);
	}

	return value;
}

/**
 * Canonicalizes schema spellings that have several equivalent OpenAPI forms.
 *
 * `const` without a `type` gains the inferred type, and 3.1 nullable type
 * arrays become an `anyOf` with `{ type: "null" }` so that source-derived
 * schemas compare equal to hand-written baselines.
 *
 * @param value - The object entry to canonicalize
 * @returns The canonical object form used for comparison
 */
function canonicalizeSchema(value: Record<string, unknown>): Record<string, unknown> {
	let result = value;

	if (
		"const" in result
		&& !("type" in result)
		&& ["string", "number", "boolean"].includes(typeof result.const)
	) {
		result = { ...result, type: typeof result.const };
	}

	if (Array.isArray(result.type) && result.type.includes("null")) {
		const rest = result.type.filter((entry) => entry !== "null");
		const { type: _type, ...others } = result;
		return {
			anyOf: [{ ...others, type: rest.length === 1 ? rest[0] : rest }, { type: "null" }],
		};
	}

	return result;
}

/**
 * Serializes a normalized value to JSON.
 *
 * @param value - The value to serialize
 * @returns The JSON string for the normalized value
 */
function stableJson(value: unknown): string {
	return JSON.stringify(normalize(value));
}

/**
 * Determines whether a value is an empty schema container.
 *
 * @param value - The value to inspect.
 * @returns `true` if `value` is an empty array or an object with no own keys, `false` otherwise.
 */
function isEmptySchemaContainer(value: unknown): boolean {
	return (
		(Array.isArray(value) && value.length === 0)
		|| (typeof value === "object"
			&& value !== null
			&& !Array.isArray(value)
			&& Object.keys(value).length === 0)
	);
}

/**
 * Reports compatibility changes between the baseline and the current OpenAPI document.
 *
 * @returns Diagnostic strings for every detected breaking change.
 */
function breakingChangeDiagnostics(baseline: OpenApiLike, current: OpenApiLike): string[] {
	const diagnostics: string[] = [];

	for (const [path, methods] of Object.entries(baseline.paths ?? {})) {
		for (const [method, baselineOperation] of Object.entries(methods)) {
			const currentOperation = current.paths?.[path]?.[method];

			if (!currentOperation) {
				diagnostics.push(`OPENAPI_REMOVED_OPERATION: ${method.toUpperCase()} ${path}`);
				continue;
			}

			diagnostics.push(
				...requiredInputDiagnostics(path, method, baselineOperation, currentOperation),
			);
		}
	}

	return diagnostics;
}

/**
 * Reports inputs that became mandatory, because callers which omit them would
 * no longer be compatible with the current operation.
 */
function requiredInputDiagnostics(
	path: string,
	method: string,
	baseline: NonNullable<OpenApiLike["paths"]>[string][string],
	current: NonNullable<OpenApiLike["paths"]>[string][string],
): string[] {
	const diagnostics: string[] = [];
	const previous = new Map(
		(baseline.parameters ?? []).flatMap((parameter) => {
			const key = parameterKey(parameter);
			return key ? [[key, parameter] as const] : [];
		}),
	);

	for (const parameter of current.parameters ?? []) {
		const key = parameterKey(parameter);

		if (!key || parameter.required !== true) {
			continue;
		}

		const before = previous.get(key);
		if (before?.required !== true) {
			const name = typeof parameter.name === "string" ? parameter.name : "unknown";
			const location = typeof parameter.in === "string" ? parameter.in : "parameter";
			diagnostics.push(
				`OPENAPI_REQUIRED_INPUT: ${method.toUpperCase()} ${path} ${location} parameter "${name}" became required`,
			);
		}
	}

	if (current.requestBody?.required === true && baseline.requestBody?.required !== true) {
		diagnostics.push(
			`OPENAPI_REQUIRED_INPUT: ${method.toUpperCase()} ${path} request body became required`,
		);
	}

	if (hasSecurity(current.security) && !hasSecurity(baseline.security)) {
		diagnostics.push(
			`OPENAPI_TIGHTER_AUTH: ${method.toUpperCase()} ${path} now requires authentication`,
		);
	}

	return diagnostics;
}

function hasSecurity(security: unknown): boolean {
	return Array.isArray(security) && security.length > 0;
}

function parameterKey(parameter: Record<string, unknown>): string | undefined {
	if (typeof parameter.name !== "string" || typeof parameter.in !== "string") {
		return undefined;
	}

	const name = parameter.in === "header" ? parameter.name.toLowerCase() : parameter.name;
	return `${parameter.in}:${name}`;
}

/**
 * Loads the OpenAPI baseline from the project.
 *
 * @param cwd - The directory containing the `.routa/openapi-baseline.json` file.
 * @returns The parsed baseline document, or `undefined` if the file does not exist.
 */
function readBaseline(cwd: string): OpenApiLike | undefined {
	const file = join(cwd, ".routa/openapi-baseline.json");

	if (!existsSync(file)) {
		return undefined;
	}

	try {
		return JSON.parse(readFileSync(file, "utf8")) as OpenApiLike;
	} catch (error) {
		const details = error instanceof Error ? error.message : String(error);
		throw new Error(
			`ROUTA_OPENAPI_BASELINE_INVALID_JSON: Could not parse .routa/openapi-baseline.json: ${details}\n`
				+ "Fix the JSON syntax, or recreate the baseline with: routa openapi breaking --update-baseline",
			{ cause: error },
		);
	}
}
