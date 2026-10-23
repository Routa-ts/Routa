import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isBodylessStatus } from "@routa-ts/core/hono";
import { type ProjectedOperation, projectContractSchemas } from "./contract-schemas.js";
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

	if (validation.diagnostics.length > 0) {
		return {
			openapi: "3.1.0",
			info: baseline?.info ?? { title: "Routa API", version: "0.0.0" },
			paths,
			"x-routa-diagnostics": validation.diagnostics.map((diagnostic) => ({
				code: diagnostic.code,
				message: diagnostic.message,
				file: diagnostic.file,
			})),
		} as OpenApiLike;
	}

	const projection = projectContractSchemas(cwd, validation.routes, parser);

	for (const route of validation.routes) {
		const operations = projection.operations.get(route.file) ?? {};
		const openApiPath = route.path.replaceAll(/:([^/]+)/g, "{$1}");
		paths[openApiPath] = Object.fromEntries(
			Object.entries(route.responses).map(([method, statuses]) => {
				const operation = operations[method];
				const baselineOperation = baseline?.paths?.[openApiPath]?.[method];
				const input = operationInput(route.path, operation?.input, baselineOperation);
				const middleware = route.methodMiddleware[method] ?? route.middleware;
				const responseSchemas = new Map([
					...(operation?.rejects ?? new Map()),
					...(operation?.responses ?? new Map()),
				]);

				return [
					method,
					{
						...operationMetadataForBaseline(baselineOperation),
						...middlewareOpenApiMetadata(middleware),
						...deprecationMetadata(operation?.deprecation),
						...input,
						responses: operationResponses(statuses, responseSchemas, baselineOperation),
					},
				];
			}),
		);
	}

	const schemas = referencedComponents(paths, projection.components);

	return {
		openapi: "3.1.0",
		info: baseline?.info ?? { title: "Routa API", version: "0.0.0" },
		paths,
		...(Object.keys(schemas).length > 0 ? { components: { schemas } } : {}),
		...(projection.warnings.length > 0
			? {
					"x-routa-schema-warnings": projection.warnings.map((warning) => ({
						code: warning.code,
						message: `${warning.file}: ${warning.message}`,
					})),
				}
			: {}),
	};
}

/**
 * Keeps the source components a document references, directly or through
 * other components, in key order.
 */
function referencedComponents(
	paths: unknown,
	components: Record<string, unknown>,
): Record<string, unknown> {
	const used = new Set<string>();
	const visit = (value: unknown): void => {
		if (Array.isArray(value)) {
			value.forEach(visit);
			return;
		}

		if (typeof value !== "object" || value === null) {
			return;
		}

		for (const [key, item] of Object.entries(value)) {
			if (key === "$ref" && typeof item === "string" && item.startsWith(componentRefPrefix)) {
				const name = item.slice(componentRefPrefix.length);

				if (!used.has(name) && name in components) {
					used.add(name);
					visit(components[name]);
				}
			} else {
				visit(item);
			}
		}
	};

	visit(paths);
	return Object.fromEntries(
		Object.keys(components)
			.filter((name) => used.has(name))
			.map((name) => [name, components[name]]),
	);
}

const componentRefPrefix = "#/components/schemas/";

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

function deprecationMetadata(
	deprecation: ProjectedOperation["deprecation"],
): Record<string, unknown> {
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

/**
 * Builds OpenAPI input for a route.
 *
 * @param path - The route path containing `:param` segments.
 * @param input - The parsed contract input for the route.
 * @returns An object containing OpenAPI `parameters` and, when present, a JSON `requestBody`.
 */
function operationInput(
	path: string,
	input: ProjectedOperation["input"] | undefined,
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

			const baselineComparable = comparableOperation(operation, baseline.components?.schemas);
			const currentComparable = comparableOperation(currentOperation, current.components?.schemas);

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
 * Component references are inlined first, so a schema compares by content
 * whether a document spells it inline or as a `$ref`.
 *
 * @returns A normalized object containing the operation's parameters, request body, and responses.
 */
function comparableOperation(
	operation: {
		parameters?: Array<Record<string, unknown>>;
		requestBody?: Record<string, unknown>;
		responses?: Record<string, unknown>;
	},
	components: Record<string, unknown> = {},
) {
	const inline = (value: unknown) => inlineComponentRefs(value, components, new Set());
	return {
		parameters: normalize(
			(operation.parameters ?? []).map((parameter) =>
				comparableParameter(inline(parameter) as Record<string, unknown>),
			),
		),
		requestBody: normalizeRequestBody(
			inline(operation.requestBody) as Record<string, unknown> | undefined,
		),
		responses: normalize(inline(operation.responses ?? {})),
	};
}

/**
 * Replaces `#/components/schemas/*` references with the referenced schema.
 * Sibling keywords next to a `$ref` apply on top of the referenced schema.
 */
function inlineComponentRefs(
	value: unknown,
	components: Record<string, unknown>,
	seen: Set<string>,
): unknown {
	if (Array.isArray(value)) {
		return value.map((item) => inlineComponentRefs(item, components, seen));
	}

	if (typeof value !== "object" || value === null) {
		return value;
	}

	const { $ref, ...rest } = value as Record<string, unknown>;
	const siblings = Object.fromEntries(
		Object.entries(rest).map(([key, item]) => [key, inlineComponentRefs(item, components, seen)]),
	);

	if (typeof $ref !== "string" || !$ref.startsWith(componentRefPrefix)) {
		return $ref === undefined ? siblings : { $ref, ...siblings };
	}

	const name = $ref.slice(componentRefPrefix.length);
	const target = components[name];

	if (typeof target !== "object" || target === null || seen.has(name)) {
		return { $ref, ...siblings };
	}

	return {
		...(inlineComponentRefs(target, components, new Set([...seen, name])) as Record<
			string,
			unknown
		>),
		...siblings,
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
