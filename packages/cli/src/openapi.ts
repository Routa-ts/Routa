import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import ts from "typescript";
import { validateProject } from "./project.js";

type OpenApiLike = {
	openapi?: string;
	info?: unknown;
	paths?: Record<
		string,
		Record<
			string,
			{
				operationId?: string;
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

	const diagnostics = removedOperationDiagnostics(baseline, current);

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

	return { code: 0, stdout: "OpenAPI breaking check passed. No removed operations detected.\n" };
}

/**
 * Builds an OpenAPI document for the current project.
 *
 * @param cwd - The project directory to inspect.
 * @returns The generated OpenAPI document, including diagnostics when project validation fails.
 */
export function generateOpenApi(cwd = process.cwd()): OpenApiLike {
	const validation = validateProject(cwd);
	const baseline = readBaseline(cwd);
	const paths: NonNullable<OpenApiLike["paths"]> = {};
	const components = baseline?.components;

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
		const contracts = readRouteContracts(cwd, route.file, components?.schemas ?? {});
		const openApiPath = route.path.replaceAll(/:([^/]+)/g, "{$1}");
		paths[openApiPath] = Object.fromEntries(
			Object.entries(route.responses).map(([method, statuses]) => {
				const baselineOperation = baseline?.paths?.[openApiPath]?.[method];
				const input = operationInput(route.path, contracts[method]?.input, baselineOperation);

				return [
					method,
					{
						...operationMetadataForBaseline(baselineOperation),
						...input,
						responses: operationResponses(
							statuses,
							contracts[method]?.responses,
							baselineOperation,
						),
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
	};
}

function isBodylessStatus(status: number): boolean {
	return status === 204 || status === 205 || status === 304;
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
): Record<string, ParsedContract> {
	const routePath = join(cwd, routeFile);
	const routeSource = readFileSync(routePath, "utf8");
	const routeAst = ts.createSourceFile(routeFile, routeSource, ts.ScriptTarget.Latest, true);
	const schemaFile = join(dirname(routePath), "schemas.ts");
	const schemas = existsSync(schemaFile)
		? readSchemaExports(schemaFile, components)
		: new SchemaReader("", components);
	const contracts: Record<string, ParsedContract> = {};

	for (const routeProperty of defineRouteProperties(routeAst)) {
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
		};
	}

	return contracts;
}

class SchemaReader {
	private readonly ast?: ts.SourceFile;
	private readonly exports = new Map<string, ts.Expression>();

	constructor(
		source: string,
		private readonly components: Record<string, unknown>,
	) {
		if (!source) {
			return;
		}

		this.ast = ts.createSourceFile("schemas.ts", source, ts.ScriptTarget.Latest, true);

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

	private schemaForName(name: string, seen: Set<string>): unknown {
		if (this.components[name]) {
			return { $ref: `#/components/schemas/${name}` };
		}

		if (seen.has(name)) {
			return {};
		}

		const expression = this.exports.get(name);

		if (!expression) {
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
			return {};
		}

		const call = callName(unwrapped.expression);

		if (call === "optional") {
			return ts.isPropertyAccessExpression(unwrapped.expression)
				? this.schemaForExpression(unwrapped.expression.expression, seen)
				: {};
		}

		if (["min", "max", "positive", "nonnegative", "negative", "nonpositive"].includes(call ?? "")) {
			return ts.isPropertyAccessExpression(unwrapped.expression)
				? this.schemaForExpression(unwrapped.expression.expression, seen)
				: {};
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

		if (call === "int") {
			return { type: "integer" };
		}

		if (call === "number") {
			return { type: "number" };
		}

		if (call === "boolean") {
			return { type: "boolean" };
		}

		if (call === "unknown" || call === "any") {
			return {};
		}

		if (call !== "object" || !ts.isObjectLiteralExpression(unwrapped.arguments[0])) {
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
 * Creates a schema reader for exported schema definitions in a file.
 *
 * @param schemaFile - Path to the TypeScript file containing schema exports
 * @param components - Component schemas available for `$ref` resolution
 * @returns A schema reader initialized with the file contents
 */
function readSchemaExports(schemaFile: string, components: Record<string, unknown>): SchemaReader {
	return new SchemaReader(readFileSync(schemaFile, "utf8"), components);
}

/**
 * Collects property assignments from object literals passed to function calls.
 *
 * @param ast - The source file to scan
 * @returns The property assignments found inside call expression arguments
 */
function defineRouteProperties(ast: ts.SourceFile): ts.PropertyAssignment[] {
	const properties: ts.PropertyAssignment[] = [];

	function visit(node: ts.Node): void {
		if (
			ts.isCallExpression(node)
			&& node.arguments.length > 0
			&& ts.isObjectLiteralExpression(node.arguments[0])
		) {
			for (const property of node.arguments[0].properties) {
				if (ts.isPropertyAssignment(property)) {
					properties.push(property);
				}
			}
		}

		ts.forEachChild(node, visit);
	}

	visit(ast);
	return properties;
}

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
function propertyName(name: ts.PropertyName): string | undefined {
	if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) {
		return name.text;
	}

	return undefined;
}

/**
 * Gets the name of a callable expression.
 *
 * @returns The identifier or property name for the expression, or `undefined` if no name can be resolved.
 */
function callName(expression: ts.Expression): string | undefined {
	const unwrapped = unwrapExpression(expression);

	if (ts.isIdentifier(unwrapped)) {
		return unwrapped.text;
	}

	if (ts.isPropertyAccessExpression(unwrapped)) {
		return unwrapped.name.text;
	}

	return undefined;
}

/**
 * Determines whether an expression calls `optional`.
 *
 * @param expression - The expression to inspect
 * @returns `true` if the expression is an `optional(...)` call, `false` otherwise.
 */
function isOptionalCall(expression: ts.Expression): boolean {
	const unwrapped = unwrapExpression(expression);
	return ts.isCallExpression(unwrapped) && callName(unwrapped.expression) === "optional";
}

/**
 * Determines whether a value is an HTTP method name.
 *
 * @param value - The value to check
 * @returns `true` if `value` is `get`, `post`, `put`, `patch`, `delete`, `head`, or `options`, `false` otherwise.
 */
function isHttpMethod(value: string): boolean {
	return ["get", "post", "put", "patch", "delete", "head", "options"].includes(value);
}

/**
 * Removes wrapper expressions and returns the inner expression.
 *
 * @param expression - The expression to unwrap
 * @returns The innermost expression after removing wrapper syntax
 */
function unwrapExpression(expression: ts.Expression): ts.Expression {
	let current = expression;

	while (
		ts.isParenthesizedExpression(current)
		|| ts.isAsExpression(current)
		|| ts.isSatisfiesExpression(current)
		|| ts.isTypeAssertionExpression(current)
		|| ts.isNonNullExpression(current)
	) {
		current = current.expression;
	}

	return current;
}

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
			const baselineResponses = baseline.paths?.[path]?.[method]?.responses ?? {};
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
		parameters: normalize(operation.parameters ?? []),
		requestBody: normalizeRequestBody(operation.requestBody),
		responses: normalize(operation.responses ?? {}),
	};
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
			Object.entries(value)
				.filter(([, item]) => !isEmptySchemaContainer(item))
				.filter(([key]) => key !== "description")
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, item]) => [key, normalize(item)]),
		);
	}

	return value;
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
 * Reports operations that exist in the baseline but are missing from the current OpenAPI document.
 *
 * @returns Diagnostic strings for each removed operation.
 */
function removedOperationDiagnostics(baseline: OpenApiLike, current: OpenApiLike): string[] {
	const diagnostics: string[] = [];

	for (const [path, methods] of Object.entries(baseline.paths ?? {})) {
		for (const method of Object.keys(methods)) {
			if (!current.paths?.[path]?.[method]) {
				diagnostics.push(`OPENAPI_REMOVED_OPERATION: ${method.toUpperCase()} ${path}`);
			}
		}
	}

	return diagnostics;
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

	return JSON.parse(readFileSync(file, "utf8")) as OpenApiLike;
}
