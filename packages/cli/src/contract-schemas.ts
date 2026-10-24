import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	createRouteObject,
	localInitializer,
	objectLiteral,
	propertyName,
	propertyValue,
	resolveImportFile,
	routeConfigObject,
	unwrapExpression,
} from "./ast.js";
import type { Diagnostic, MiddlewareMetadata, RouteMetadata } from "./project.js";
import * as ts from "./typescript.js";

/**
 * An OpenAPI 3.1 Schema Object projected from a Zod schema.
 */
export type JsonSchema = Record<string, unknown>;

type InputField = "params" | "query" | "headers" | "cookies" | "body";

/**
 * The schema-backed parts of one route method, projected for OpenAPI.
 */
export type ProjectedOperation = {
	input: Partial<Record<InputField, JsonSchema>>;
	responses: Map<number, JsonSchema>;
	rejects: Map<number, JsonSchema>;
	deprecation?: { sunset?: string; replacement?: string };
};

/**
 * Every route schema in a project, projected statically from source.
 */
export type ContractSchemaProjection = {
	operations: Map<string, Record<string, ProjectedOperation>>;
	components: Record<string, JsonSchema>;
	diagnostics: Diagnostic[];
	warnings: Diagnostic[];
};

/**
 * Projects route input, route outcome, and middleware reject schemas to
 * OpenAPI 3.1 without importing or executing application modules.
 *
 * Input schemas project the incoming side. Response schemas project the
 * outgoing side and reject constructs that change values.
 *
 * @param cwd - The project root
 * @param routes - Route metadata from project discovery
 * @param parser - The TypeScript source-file parser for this session
 * @returns Projected operations, components, and coded diagnostics
 */
export function projectContractSchemas(
	cwd: string,
	routes: readonly RouteMetadata[],
	parser: ts.SourceFileParser,
): ContractSchemaProjection {
	const projector = new SchemaProjector(cwd, parser);
	const operations = new Map<string, Record<string, ProjectedOperation>>();

	for (const route of routes) {
		const contracts = projector.routeContracts(route.file, Object.keys(route.responses));
		const methods: Record<string, ProjectedOperation> = {};

		for (const method of Object.keys(route.responses)) {
			const middleware = route.methodMiddleware[method] ?? route.middleware;
			methods[method] = {
				...(contracts[method] ?? { input: {}, responses: new Map() }),
				rejects: projector.middlewareRejects(middleware),
			};
		}

		operations.set(route.file, methods);
	}

	return {
		operations,
		components: projector.componentSchemas(),
		diagnostics: projector.diagnostics.filter((item) => item.severity === "error"),
		warnings: projector.diagnostics.filter((item) => item.severity === "warning"),
	};
}

type SchemaIo = "input" | "output";

type Declaration = {
	name: string;
	initializer: ts.Expression;
	exported: boolean;
	source: SchemaSource;
};

/**
 * A source file whose top-level declarations can back schema identifiers.
 */
type SchemaSource = {
	file: string;
	declarations: Map<string, Declaration>;
	imports: Set<string>;
	importFiles: Map<string, string>;
	zodNamespaces: Set<string>;
	zodRegistries: Set<string>;
	routaHelpers: Map<string, "Sort" | "Fields">;
	fallback?: SchemaSource;
};

type Context = {
	source: SchemaSource;
	io: SchemaIo;
};

type ComponentIdentity = {
	key: string;
	explicit: boolean;
	identity: string;
	file: string;
};

/**
 * A projected schema before it is placed in a document.
 *
 * `schema` holds the structural keywords and `meta` the documentation
 * keywords, kept apart so clones can inherit metadata the way Zod's registry
 * does. `component` is set when the schema owns a `components.schemas` key.
 */
type SchemaNode = {
	schema: JsonSchema;
	meta: JsonSchema;
	optional: boolean;
	opaque?: boolean;
	component?: ComponentIdentity;
};

const componentKeyPattern = /^[a-zA-Z0-9.\-_]+$/;

const allowedMetaKeys = new Set([
	"title",
	"description",
	"deprecated",
	"example",
	"examples",
	"readOnly",
	"writeOnly",
	"externalDocs",
]);

const structuralMetaKeys = new Set([
	"$anchor",
	"$defs",
	"$id",
	"$ref",
	"$schema",
	"additionalProperties",
	"allOf",
	"anyOf",
	"const",
	"contains",
	"contentEncoding",
	"contentMediaType",
	"default",
	"definitions",
	"dependentRequired",
	"dependentSchemas",
	"discriminator",
	"else",
	"enum",
	"exclusiveMaximum",
	"exclusiveMinimum",
	"format",
	"if",
	"items",
	"maxItems",
	"maxLength",
	"maxProperties",
	"maximum",
	"minItems",
	"minLength",
	"minProperties",
	"minimum",
	"multipleOf",
	"not",
	"nullable",
	"oneOf",
	"pattern",
	"patternProperties",
	"prefixItems",
	"properties",
	"propertyNames",
	"required",
	"then",
	"type",
	"unevaluatedItems",
	"unevaluatedProperties",
	"uniqueItems",
]);

const placementMetaKeys = new Set([
	"allowEmptyValue",
	"allowReserved",
	"cookie",
	"explode",
	"header",
	"in",
	"name",
	"operationId",
	"param",
	"path",
	"query",
	"responses",
	"security",
	"status",
	"style",
	"summary",
	"tags",
]);

/**
 * Methods that add a validation check and keep the receiver's type.
 */
const checkMethods = new Set([
	"check",
	"endsWith",
	"finite",
	"gt",
	"gte",
	"includes",
	"length",
	"lowercase",
	"lt",
	"lte",
	"max",
	"min",
	"multipleOf",
	"negative",
	"nonempty",
	"nonnegative",
	"nonpositive",
	"positive",
	"refine",
	"regex",
	"safe",
	"startsWith",
	"step",
	"superRefine",
	"uppercase",
]);

/**
 * Methods, and the matching `.check()` factories such as `z.trim()`, that keep
 * the receiver's type but rewrite the parsed value.
 */
const valueMutatingMethods = new Set([
	"normalize",
	"overwrite",
	"slugify",
	"toLowerCase",
	"toUpperCase",
	"trim",
]);

/**
 * Zod string formats, keyed by factory name (`z.email()`, `z.iso.date()`),
 * mapped to the OpenAPI `format` they document. An empty format documents a
 * plain string.
 */
const stringFormats: Record<string, string> = {
	email: "email",
	uuid: "uuid",
	uuidv4: "uuid",
	uuidv6: "uuid",
	uuidv7: "uuid",
	guid: "uuid",
	url: "uri",
	httpUrl: "uri",
	hostname: "hostname",
	ipv4: "ipv4",
	ipv6: "ipv6",
	"iso.datetime": "date-time",
	"iso.date": "date",
	"iso.time": "time",
	"iso.duration": "duration",
	base64: "",
	base64url: "",
	cidrv4: "",
	cidrv6: "",
	cuid: "",
	cuid2: "",
	e164: "",
	emoji: "",
	hex: "",
	jwt: "",
	ksuid: "",
	mac: "",
	nanoid: "",
	ulid: "",
	xid: "",
};

/**
 * Deprecated string methods such as `z.string().email()`, mapped to the same
 * formats as their factories.
 */
const stringFormatMethods: Record<string, string> = {
	email: "email",
	uuid: "uuid",
	url: "uri",
	datetime: "date-time",
};

const numberFactories: Record<string, string> = {
	number: "number",
	float32: "number",
	float64: "number",
	int: "integer",
	int32: "integer",
	uint32: "integer",
};

function stringNode(format: string): SchemaNode {
	return plainNode(format ? { type: "string", format } : { type: "string" });
}

const unsupportedSuggestion =
	"Use a supported Zod construct: primitives, z.literal, z.enum, z.object, z.array, z.record, z.union, z.discriminatedUnion, z.intersection or .and(), .optional(), .nullable(), checks such as .min(), and .meta() or .describe().";

class SchemaProjector {
	readonly diagnostics: Diagnostic[] = [];
	private readonly sources = new Map<string, SchemaSource>();
	private readonly declarationNodes = new Map<string, SchemaNode>();
	private readonly inProgress = new Set<string>();
	private readonly components = new Map<string, ComponentIdentity & { content: JsonSchema }>();
	private readonly rejectCache = new Map<string, JsonSchema>();
	private readonly scannedRegistries = new Set<string>();

	constructor(
		private readonly cwd: string,
		private readonly parser: ts.SourceFileParser,
	) {}

	/**
	 * Projects the `createRoute` contracts declared in a route file.
	 */
	routeContracts(
		routeFile: string,
		methods: readonly string[],
	): Record<string, Omit<ProjectedOperation, "rejects">> {
		const schemasFile = join(dirname(routeFile), "schemas.ts");
		const schemas = existsSync(join(this.cwd, schemasFile)) ? this.source(schemasFile) : undefined;
		const route = this.source(routeFile, schemas);
		const config = routeConfigObject(this.parse(routeFile));
		const contracts: Record<string, Omit<ProjectedOperation, "rejects">> = {};

		for (const method of methods) {
			const value = config && propertyValue(config, method);
			const contract = value && createRouteObject(value);

			if (!contract) {
				continue;
			}

			contracts[method] = {
				input: this.inputSchemas(contract, route),
				responses: this.responseSchemas(contract, route),
				deprecation: readDeprecation(contract),
			};
		}

		return contracts;
	}

	/**
	 * Projects terminal middleware reject schemas, keyed by status.
	 *
	 * Identifiers resolve against the middleware's own source file.
	 */
	middlewareRejects(middleware: readonly MiddlewareMetadata[]): Map<number, JsonSchema> {
		const schemas = new Map<number, JsonSchema>();

		for (const item of middleware) {
			for (const reject of item.rejects) {
				const key = `${item.file}#${item.name}#${reject.type}`;
				let schema = this.rejectCache.get(key);

				if (!schema) {
					const source = this.middlewareSource(item);
					const virtualFile = join(".routa", "middleware-rejects", `${key}.ts`);
					const ast = this.parser.createSourceFile(virtualFile, `const schema = ${reject.schema};`);
					const initializer = localInitializer(ast, "schema");
					schema = initializer
						? this.materialize(this.node(initializer, { source, io: "output" }))
						: {};
					this.rejectCache.set(key, schema);
				}

				schemas.set(reject.status, schema);
			}
		}

		return schemas;
	}

	/**
	 * Finds the file that declares a middleware. Route files record middleware
	 * they import under their own path, so follow that import one step.
	 */
	private middlewareSource(item: MiddlewareMetadata): SchemaSource {
		const source = this.source(item.file);
		const imported = source.declarations.has(item.name)
			? undefined
			: source.importFiles.get(item.name);
		return imported ? this.source(imported) : source;
	}

	/**
	 * Returns every component registered while projecting, sorted by key.
	 */
	componentSchemas(): Record<string, JsonSchema> {
		return Object.fromEntries(
			Array.from(this.components.entries())
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, component]) => [key, component.content]),
		);
	}

	private inputSchemas(
		contract: ts.ObjectLiteralExpression,
		source: SchemaSource,
	): ProjectedOperation["input"] {
		const value = propertyValue(contract, "input");
		const input = objectLiteral(value);
		const result: ProjectedOperation["input"] = {};

		if (value && !input) {
			this.unreadableInput(value, source);
		}

		for (const property of input?.properties ?? []) {
			const name =
				ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)
					? propertyName(property.name)
					: undefined;

			if (!name) {
				this.unreadableInput(property, source);
				continue;
			}

			const expression = input && propertyValue(input, name);

			if (!expression || !isInputField(name)) {
				continue;
			}

			const node = this.node(expression, { source, io: "input" });
			result[name] =
				name === "body"
					? this.materialize(node)
					: this.parameterContainer(node, name, expression, source);
		}

		return result;
	}

	private unreadableInput(node: ts.Node, source: SchemaSource): void {
		this.unsupported(
			node,
			{ source, io: "input" },
			"route input needs static params, query, headers, cookies, or body properties",
		);
	}

	private responseSchemas(
		contract: ts.ObjectLiteralExpression,
		source: SchemaSource,
	): Map<number, JsonSchema> {
		const responses = objectLiteral(propertyValue(contract, "responses"));
		const result = new Map<number, JsonSchema>();

		for (const response of responses?.properties ?? []) {
			const outcome = ts.isPropertyAssignment(response)
				? objectLiteral(response.initializer)
				: undefined;
			const status = outcome && numericLiteral(propertyValue(outcome, "status"));
			const schema = outcome && propertyValue(outcome, "schema");

			if (status && schema) {
				result.set(status, this.materialize(this.node(schema, { source, io: "output" })));
			}
		}

		return result;
	}

	/**
	 * Projects a root `params`, `query`, `headers`, or `cookies` schema.
	 *
	 * These containers split into OpenAPI parameters, so they never become
	 * components themselves.
	 */
	private parameterContainer(
		node: SchemaNode,
		field: InputField,
		expression: ts.Expression,
		source: SchemaSource,
	): JsonSchema {
		const schema = this.content(node);

		if (schema.type !== "object" || typeof schema.properties !== "object") {
			this.report(source, expression, {
				code: "ROUTA_SCHEMA_UNSUPPORTED",
				message: `Input ${field} must be an object schema so Routa can split it into OpenAPI parameters`,
				suggestion: `Declare ${field} with z.object({ ... }).`,
			});
		}

		return schema;
	}

	private source(file: string, fallback?: SchemaSource): SchemaSource {
		const key = `${file}\0${fallback?.file ?? ""}`;
		const cached = this.sources.get(key);

		if (cached) {
			return cached;
		}

		const ast = this.parse(file);
		const source: SchemaSource = {
			file,
			declarations: new Map(),
			imports: new Set(),
			importFiles: new Map(),
			zodNamespaces: new Set(),
			zodRegistries: new Set(),
			routaHelpers: new Map(),
			fallback,
		};

		for (const statement of ast.statements) {
			if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
				const specifier = statement.moduleSpecifier.text;
				readImport(statement, specifier, source, resolveImportFile(this.cwd, file, specifier));
				continue;
			}

			if (!ts.isVariableStatement(statement)) {
				continue;
			}

			const exported = Boolean(
				statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword),
			);

			for (const declaration of statement.declarationList.declarations) {
				if (ts.isIdentifier(declaration.name) && declaration.initializer) {
					source.declarations.set(declaration.name.text, {
						name: declaration.name.text,
						initializer: declaration.initializer,
						exported,
						source,
					});
				}
			}
		}

		if (source.zodNamespaces.size === 0) {
			source.zodNamespaces.add("z");
		}

		this.sources.set(key, source);
		this.reportRegistryUse(ast, source);
		return source;
	}

	private parse(file: string): ts.SourceFile {
		return this.parser.createSourceFile(
			join(this.cwd, file),
			readFileSync(join(this.cwd, file), "utf8"),
		);
	}

	/**
	 * Reports `z.globalRegistry` and `z.registry()` use, which would attach
	 * metadata outside the schemas Routa reads from the route graph.
	 */
	private reportRegistryUse(ast: ts.SourceFile, source: SchemaSource): void {
		if (this.scannedRegistries.has(source.file)) {
			return;
		}

		this.scannedRegistries.add(source.file);

		const visit = (node: ts.Node): void => {
			const registry =
				ts.isPropertyAccessExpression(node)
				&& ts.isIdentifier(node.expression)
				&& source.zodNamespaces.has(node.expression.text)
				&& zodRegistryNames.has(node.name.text)
					? node.name.text
					: ts.isIdentifier(node)
						  && source.zodRegistries.has(node.text)
						  && !ts.isImportSpecifier(node.parent)
						? node.text
						: undefined;

			if (registry) {
				this.report(source, node, {
					code: "ROUTA_SCHEMA_REGISTRY",
					message: `Zod ${registry} metadata is not part of the route contract`,
					suggestion:
						"Attach documentation with .meta({ ... }) or .describe() on the schema the route uses.",
				});
			}

			ts.forEachChild(node, visit);
		};

		visit(ast);
	}

	private node(expression: ts.Expression, context: Context): SchemaNode {
		const unwrapped = unwrapExpression(expression);

		if (ts.isIdentifier(unwrapped)) {
			return this.declarationNode(unwrapped, context);
		}

		if (!ts.isCallExpression(unwrapped)) {
			return this.unsupported(expression, context, "expected a Zod schema expression");
		}

		const callee = unwrapExpression(unwrapped.expression);
		const factory = zodFactory(callee, context.source);

		if (factory) {
			return this.factory(factory, unwrapped, context);
		}

		if (ts.isIdentifier(callee)) {
			const helper = context.source.routaHelpers.get(callee.text);
			return helper
				? this.routaHelper(helper, unwrapped, context)
				: this.unsupported(
						unwrapped,
						context,
						`calls to ${callee.text}() cannot be analyzed statically`,
					);
		}

		if (ts.isPropertyAccessExpression(callee)) {
			return this.method(callee.name.text, callee.expression, unwrapped, context);
		}

		return this.unsupported(unwrapped, context, "expected a Zod schema expression");
	}

	private declarationNode(identifier: ts.Identifier, context: Context): SchemaNode {
		const name = identifier.text;
		const declaration = lookup(context.source, name);

		if (!declaration) {
			this.report(context.source, identifier, {
				code: "ROUTA_SCHEMA_UNRESOLVED",
				message: context.source.imports.has(name)
					? `Schema ${name} is imported, and Routa reads schemas only from the route's schemas.ts or the declaring file`
					: `Schema ${name} could not be resolved`,
				suggestion:
					"Declare the schema in the route's schemas.ts, or in the same file as the middleware or route that uses it.",
			});
			return emptyNode();
		}

		const key = `${declaration.source.file}#${name}#${context.io}`;
		const cached = this.declarationNodes.get(key);

		if (cached) {
			return cached;
		}

		if (this.inProgress.has(key)) {
			return this.unsupported(identifier, context, `schema ${name} refers to itself`);
		}

		this.inProgress.add(key);
		let node = this.node(declaration.initializer, { ...context, source: declaration.source });
		this.inProgress.delete(key);

		if (!node.component && declaration.exported) {
			node = {
				...node,
				component: {
					key: name,
					explicit: false,
					identity: `${declaration.source.file}#${name}`,
					file: declaration.source.file,
				},
			};
		}

		this.declarationNodes.set(key, node);
		return node;
	}

	private factory(name: string, call: ts.CallExpression, context: Context): SchemaNode {
		const [first, second] = call.arguments;

		if (Object.hasOwn(stringFormats, name)) {
			return stringNode(stringFormats[name]);
		}

		if (Object.hasOwn(numberFactories, name)) {
			return plainNode({ type: numberFactories[name] });
		}

		switch (name) {
			case "string":
				return plainNode({ type: "string" });
			case "date":
				return this.unsupported(
					call,
					context,
					"z.date() values are not JSON; use z.iso.datetime()",
				);
			case "boolean":
				return plainNode({ type: "boolean" });
			case "null":
				return plainNode({ type: "null" });
			case "unknown":
			case "any":
				return plainNode({});
			case "literal":
				return this.literal(call, context);
			case "enum":
				return this.enumeration(call, context);
			case "object":
			case "looseObject":
				return this.object(call, context);
			case "strictObject": {
				const node = this.object(call, context);
				return { ...node, schema: { ...node.schema, additionalProperties: false } };
			}
			case "array":
				return first ? this.array(this.node(first, context)) : this.missing(call, context);
			case "record": {
				const value = call.arguments[call.arguments.length - 1];
				return plainNode({
					type: "object",
					additionalProperties: value ? this.materialize(this.node(value, context)) : {},
				});
			}
			case "union":
				return this.union(call, first, context);
			case "discriminatedUnion":
				return this.discriminatedUnion(call, context);
			case "intersection":
				return first && second
					? this.intersection([this.node(first, context), this.node(second, context)])
					: this.missing(call, context);
			case "optional":
			case "nullable":
			case "nullish":
				return first ? this.wrapper(name, this.node(first, context)) : this.missing(call, context);
			case "stringbool":
				// Like z.coerce.number() as `number`, this documents the parameter
				// convention, where `type: boolean` means the strings "true" and "false".
				return this.mutation(call, context, "z.stringbool()", plainNode({ type: "boolean" }));
			case "coerce.string":
			case "coerce.number":
			case "coerce.boolean":
				return this.mutation(
					call,
					context,
					`z.${name}()`,
					plainNode({ type: name.replace("coerce.", "") }),
				);
			case "preprocess":
				return this.opaqueInput(call, context, "z.preprocess()", second);
			case "transform":
				return this.opaqueInput(call, context, "z.transform()");
			case "pipe":
				return first && second
					? this.pipe(this.node(first, context), second, call, context)
					: this.missing(call, context);
			case "codec":
				if (context.io === "output") {
					this.reportMutation(call, context, "a codec");
				}
				return first ? this.node(first, context) : this.missing(call, context);
			default:
				return this.unsupported(call, context, `z.${name}() is not supported`);
		}
	}

	private method(
		name: string,
		receiverExpression: ts.Expression,
		call: ts.CallExpression,
		context: Context,
	): SchemaNode {
		const receiver = () => this.node(receiverExpression, context);
		const [first] = call.arguments;

		if (name === "brand") {
			return receiver();
		}

		if (name === "optional" || name === "nullable" || name === "nullish" || name === "readonly") {
			return this.wrapper(name, receiver());
		}

		if (name === "nonoptional") {
			return { ...this.passthrough(receiver()), optional: false };
		}

		if (name === "describe") {
			const description = first && stringLiteral(first);

			if (description === undefined) {
				this.reportComputedMeta(call, context, ".describe() needs a string literal");
				return receiver();
			}

			return this.clone(receiver(), { description });
		}

		if (name === "meta") {
			return this.withMeta(receiver(), call, context);
		}

		if (name === "check" && context.io === "output") {
			for (const argument of call.arguments) {
				const check = unwrapExpression(argument);
				const factory = ts.isCallExpression(check)
					? zodFactory(unwrapExpression(check.expression), context.source)
					: undefined;

				if (factory && valueMutatingMethods.has(factory)) {
					this.reportMutation(check, context, `z.${factory}()`);
				}
			}
		}

		if (checkMethods.has(name)) {
			return this.clone(receiver(), {});
		}

		if (name === "int") {
			const node = this.clone(receiver(), {});
			return { ...node, schema: { ...node.schema, type: "integer" } };
		}

		if (Object.hasOwn(stringFormatMethods, name)) {
			const node = this.clone(receiver(), {});
			return { ...node, schema: { ...node.schema, format: stringFormatMethods[name] } };
		}

		if (valueMutatingMethods.has(name)) {
			return this.mutation(call, context, `.${name}()`, this.clone(receiver(), {}));
		}

		if (name === "default" || name === "catch" || name === "prefault") {
			const node = this.passthrough(receiver());
			return this.mutation(
				call,
				context,
				`.${name}()`,
				context.io === "input" ? { ...node, optional: true } : { ...node, optional: false },
			);
		}

		if (name === "transform") {
			return this.mutation(call, context, ".transform()", this.passthrough(receiver()));
		}

		if (name === "pipe") {
			return first ? this.pipe(receiver(), first, call, context) : this.missing(call, context);
		}

		if (name === "and") {
			return first
				? this.intersection([receiver(), this.node(first, context)])
				: this.missing(call, context);
		}

		if (name === "or") {
			return first
				? this.anyOf([receiver(), this.node(first, context)])
				: this.missing(call, context);
		}

		if (name === "array") {
			return this.array(receiver());
		}

		if (name === "strict" || name === "strip" || name === "loose" || name === "passthrough") {
			const node = receiver();
			const schema = { ...node.schema };

			if (schema.type !== "object") {
				return this.unsupported(call, context, `.${name}() needs an object schema`);
			}

			if (name === "strict") {
				schema.additionalProperties = false;
			} else {
				delete schema.additionalProperties;
			}

			return { schema, meta: {}, optional: false };
		}

		if (name === "register") {
			this.report(context.source, call, {
				code: "ROUTA_SCHEMA_REGISTRY",
				message: "Zod registry metadata is not part of the route contract",
				suggestion:
					"Attach documentation with .meta({ ... }) or .describe() on the schema the route uses.",
			});
			return receiver();
		}

		return this.unsupported(call, context, `.${name}() is not supported`);
	}

	private routaHelper(
		helper: "Sort" | "Fields",
		call: ts.CallExpression,
		context: Context,
	): SchemaNode {
		return this.mutation(call, context, `${helper}()`, plainNode({ type: "string" }));
	}

	private literal(call: ts.CallExpression, context: Context): SchemaNode {
		const value = call.arguments[0] && jsonLiteral(call.arguments[0]);

		if (value === undefined || (typeof value === "object" && value !== null)) {
			return this.unsupported(
				call,
				context,
				"z.literal() needs a string, number, boolean, or null literal",
			);
		}

		return plainNode(value === null ? { type: "null" } : { type: typeof value, const: value });
	}

	private enumeration(call: ts.CallExpression, context: Context): SchemaNode {
		const argument = call.arguments[0] && unwrapExpression(call.arguments[0]);
		const values =
			argument && ts.isArrayLiteralExpression(argument)
				? argument.elements.map((element) => stringLiteral(element))
				: undefined;

		if (!values || values.some((value) => value === undefined)) {
			return this.unsupported(call, context, "z.enum() needs an inline array of string literals");
		}

		return plainNode({ type: "string", enum: values });
	}

	private object(call: ts.CallExpression, context: Context): SchemaNode {
		const shape = call.arguments[0] && unwrapExpression(call.arguments[0]);

		if (!shape || !ts.isObjectLiteralExpression(shape)) {
			return this.unsupported(call, context, "z.object() needs an inline object literal shape");
		}

		const properties: JsonSchema = {};
		const required: string[] = [];

		for (const property of shape.properties) {
			const name =
				ts.isShorthandPropertyAssignment(property) || ts.isPropertyAssignment(property)
					? propertyName(property.name)
					: undefined;

			if (!name) {
				this.unsupported(
					property,
					context,
					"object shapes need static property names without spreads",
				);
				continue;
			}

			const node =
				ts.isShorthandPropertyAssignment(property) && ts.isIdentifier(property.name)
					? this.declarationNode(property.name, context)
					: this.node((property as ts.PropertyAssignment).initializer, context);
			properties[name] = this.materialize(node);

			if (!node.optional) {
				required.push(name);
			}
		}

		return plainNode({
			type: "object",
			...(required.length > 0 ? { required } : {}),
			properties,
		});
	}

	private array(items: SchemaNode): SchemaNode {
		return plainNode({ type: "array", items: this.materialize(items) });
	}

	private union(
		call: ts.CallExpression,
		options: ts.Expression | undefined,
		context: Context,
	): SchemaNode {
		const members = options && unwrapExpression(options);

		if (!members || !ts.isArrayLiteralExpression(members)) {
			return this.unsupported(call, context, "z.union() needs an inline array of schemas");
		}

		return this.anyOf(members.elements.map((element) => this.node(element, context)));
	}

	private anyOf(nodes: SchemaNode[]): SchemaNode {
		return {
			schema: { anyOf: nodes.map((node) => this.materialize(node)) },
			meta: {},
			optional: nodes.some((node) => node.optional),
		};
	}

	private discriminatedUnion(call: ts.CallExpression, context: Context): SchemaNode {
		const [discriminator, options] = call.arguments;
		const propertyName = discriminator && stringLiteral(discriminator);
		const members = options && unwrapExpression(options);

		if (propertyName === undefined || !members || !ts.isArrayLiteralExpression(members)) {
			return this.unsupported(
				call,
				context,
				"z.discriminatedUnion() needs a string literal key and an inline array of schemas",
			);
		}

		return plainNode({
			oneOf: members.elements.map((element) => this.materialize(this.node(element, context))),
			discriminator: { propertyName },
		});
	}

	/**
	 * Projects an intersection as `allOf`, folding plain object members into
	 * one object the way Zod's native converter does.
	 */
	private intersection(nodes: SchemaNode[]): SchemaNode {
		const members = nodes.flatMap((node) => {
			const schema = this.materialize(node);
			return Array.isArray(schema.allOf) && Object.keys(schema).length === 1
				? (schema.allOf as JsonSchema[])
				: [schema];
		});

		return plainNode(foldObjects(members) ?? { allOf: members });
	}

	private wrapper(
		name: "optional" | "nullable" | "nullish" | "readonly",
		inner: SchemaNode,
	): SchemaNode {
		if (name === "optional") {
			return { ...this.passthrough(inner), optional: true };
		}

		if (name === "readonly") {
			return this.passthrough(inner);
		}

		return {
			schema: { anyOf: [this.materialize(inner), { type: "null" }] },
			meta: {},
			optional: name === "nullish" || inner.optional,
		};
	}

	private pipe(
		from: SchemaNode,
		toExpression: ts.Expression,
		call: ts.CallExpression,
		context: Context,
	): SchemaNode {
		const to = this.node(toExpression, context);

		if (context.io === "input") {
			return from.opaque ? to : from;
		}

		if (stableJson(this.content(from)) !== stableJson(this.content(to))) {
			this.reportMutation(call, context, ".pipe() into a different schema");
		}

		return to;
	}

	/**
	 * Projects a schema whose incoming side is a function Routa cannot read.
	 */
	private opaqueInput(
		call: ts.CallExpression,
		context: Context,
		construct: string,
		target?: ts.Expression,
	): SchemaNode {
		if (context.io === "output") {
			this.reportMutation(call, context, construct);
		} else {
			this.report(context.source, call, {
				code: "ROUTA_SCHEMA_OPAQUE_INPUT",
				severity: "warning",
				message: `${construct} accepts input Routa cannot describe, so OpenAPI documents the schema after preprocessing`,
				suggestion:
					"Parse the incoming value with a declarative schema first, then use .transform() or .pipe() to change it.",
			});
		}

		const node = target ? this.node(target, context) : plainNode({});
		return { ...node, opaque: target === undefined };
	}

	private mutation(
		call: ts.CallExpression,
		context: Context,
		construct: string,
		node: SchemaNode,
	): SchemaNode {
		if (context.io === "output") {
			this.reportMutation(call, context, construct);
		}

		return node;
	}

	private reportMutation(call: ts.Node, context: Context, construct: string): void {
		this.report(context.source, call, {
			code: "ROUTA_RESPONSE_SCHEMA_MUTATION",
			message: `Response schema changes values with ${construct}`,
			suggestion:
				"Response schemas describe wire-ready JSON. Return the final value from the handler and keep the response schema validation-only.",
		});
	}

	/**
	 * Applies `.meta({ ... })`. Only literal, documentation-only keys are
	 * accepted; `id` names a component.
	 */
	private withMeta(receiver: SchemaNode, call: ts.CallExpression, context: Context): SchemaNode {
		const argument = call.arguments[0] && unwrapExpression(call.arguments[0]);

		if (!argument || !ts.isObjectLiteralExpression(argument)) {
			this.reportComputedMeta(call, context, ".meta() needs an inline object literal");
			return receiver;
		}

		const meta: JsonSchema = {};
		let id: string | undefined;

		for (const property of argument.properties) {
			const key = ts.isPropertyAssignment(property) ? propertyName(property.name) : undefined;

			if (!key || !ts.isPropertyAssignment(property)) {
				this.reportComputedMeta(
					property,
					context,
					"metadata keys must be static properties without spreads",
				);
				continue;
			}

			if (!key.startsWith("x-") && key !== "id" && !allowedMetaKeys.has(key)) {
				this.reportMetaKey(property, key, context);
				continue;
			}

			const value = jsonLiteral(property.initializer);

			if (value === undefined) {
				this.reportComputedMeta(property, context, `metadata "${key}" must be a literal value`);
				continue;
			}

			if (key === "id") {
				if (typeof value !== "string" || !componentKeyPattern.test(value)) {
					this.report(context.source, property, {
						code: "ROUTA_SCHEMA_COMPONENT_ID_INVALID",
						message: `Schema id ${JSON.stringify(value)} is not a valid OpenAPI component name`,
						suggestion: "Use letters, digits, '.', '-', or '_' in schema ids.",
					});
					continue;
				}

				id = value;
				continue;
			}

			meta[key] = value;
		}

		const node = this.clone(receiver, meta);
		return id
			? {
					...node,
					component: {
						key: id,
						explicit: true,
						identity: `${call.getSourceFile().fileName}:${call.pos}`,
						file: context.source.file,
					},
				}
			: node;
	}

	private reportMetaKey(property: ts.Node, key: string, context: Context): void {
		if (structuralMetaKeys.has(key)) {
			this.report(context.source, property, {
				code: "ROUTA_SCHEMA_META_STRUCTURAL",
				message: `Metadata "${key}" would override the schema structure Zod already defines`,
				suggestion: `Express "${key}" with the Zod schema itself, and keep .meta() for documentation.`,
			});
			return;
		}

		if (placementMetaKeys.has(key)) {
			this.report(context.source, property, {
				code: "ROUTA_SCHEMA_META_PLACEMENT",
				message: `Metadata "${key}" describes where a value appears in a route, which the route contract already decides`,
				suggestion: "Place the schema under input or responses in createRoute instead.",
			});
			return;
		}

		this.report(context.source, property, {
			code: "ROUTA_SCHEMA_META_UNSUPPORTED",
			message: `Metadata "${key}" is not supported`,
			suggestion:
				"Use id, title, description, deprecated, example, examples, readOnly, writeOnly, externalDocs, or an x- extension.",
		});
	}

	private reportComputedMeta(node: ts.Node, context: Context, detail: string): void {
		this.report(context.source, node, {
			code: "ROUTA_SCHEMA_META_COMPUTED",
			message: `Schema metadata cannot be analyzed statically: ${detail}`,
			suggestion:
				"Write metadata as inline literals so Routa can read it without running your code.",
		});
	}

	/**
	 * A Zod clone: a new schema with the receiver's structure and inherited
	 * metadata. Like Zod's registry, inheritance drops the parent's `id`.
	 */
	private clone(receiver: SchemaNode, meta: JsonSchema): SchemaNode {
		return {
			schema: receiver.schema,
			meta: { ...receiver.meta, ...meta },
			optional: receiver.optional,
			...(receiver.opaque ? { opaque: true } : {}),
		};
	}

	/**
	 * A Zod wrapper that projects as its inner schema, keeping the inner
	 * schema's component reference.
	 */
	private passthrough(inner: SchemaNode): SchemaNode {
		return inner.component
			? { schema: this.materialize(inner), meta: {}, optional: inner.optional }
			: { ...inner };
	}

	private content(node: SchemaNode): JsonSchema {
		return { ...node.schema, ...node.meta };
	}

	/**
	 * Places a node in a document: a component reference when it owns a key,
	 * otherwise the inline schema.
	 */
	private materialize(node: SchemaNode): JsonSchema {
		if (!node.component) {
			return this.content(node);
		}

		this.registerComponent(node.component, this.content(node));
		return { $ref: `#/components/schemas/${node.component.key}` };
	}

	private registerComponent(component: ComponentIdentity, content: JsonSchema): void {
		const existing = this.components.get(component.key);

		if (!existing) {
			if (!componentKeyPattern.test(component.key)) {
				this.diagnostics.push({
					code: "ROUTA_SCHEMA_COMPONENT_ID_INVALID",
					severity: "error",
					message: `Schema export ${component.key} is not a valid OpenAPI component name.`,
					file: component.file,
					suggestion: "Rename the export, or give it a valid .meta({ id }).",
				});
			}

			this.components.set(component.key, { ...component, content });
			return;
		}

		if (existing.identity === component.identity) {
			return;
		}

		if (
			!existing.explicit
			&& !component.explicit
			&& stableJson(existing.content) === stableJson(content)
		) {
			return;
		}

		const files = Array.from(new Set([existing.file, component.file])).join(" and ");
		pushUnique(this.diagnostics, {
			code: "ROUTA_SCHEMA_COMPONENT_COLLISION",
			severity: "error",
			message:
				existing.explicit || component.explicit
					? `Different schemas in ${files} claim component ${component.key}.`
					: `Different schemas named ${component.key} in ${files} would share one OpenAPI component.`,
			file: component.file,
			suggestion:
				"Reuse one declaration, or give each schema a distinct .meta({ id }). Routa never renames components.",
		});
	}

	private unsupported(node: ts.Node, context: Context, detail: string): SchemaNode {
		this.report(context.source, node, {
			code: "ROUTA_SCHEMA_UNSUPPORTED",
			message: `Unsupported schema for OpenAPI (${detail})`,
			suggestion: unsupportedSuggestion,
		});
		return emptyNode();
	}

	private missing(call: ts.CallExpression, context: Context): SchemaNode {
		return this.unsupported(call, context, "missing schema argument");
	}

	private report(
		source: SchemaSource,
		node: ts.Node,
		diagnostic: {
			code: string;
			message: string;
			suggestion: string;
			severity?: "error" | "warning";
		},
	): void {
		const text = node.getText(node.getSourceFile()).replaceAll(/\s+/g, " ").slice(0, 80);
		pushUnique(this.diagnostics, {
			code: diagnostic.code,
			severity: diagnostic.severity ?? "error",
			message: `${diagnostic.message}: ${text}`,
			file: source.file,
			suggestion: diagnostic.suggestion,
		});
	}
}

const zodRegistryNames = new Set(["globalRegistry", "registry"]);

function isInputField(value: string): value is InputField {
	return ["params", "query", "headers", "cookies", "body"].includes(value);
}

function plainNode(schema: JsonSchema): SchemaNode {
	return { schema, meta: {}, optional: false };
}

function emptyNode(): SchemaNode {
	return plainNode({});
}

function lookup(source: SchemaSource, name: string): Declaration | undefined {
	return source.declarations.get(name) ?? (source.fallback && lookup(source.fallback, name));
}

function pushUnique(diagnostics: Diagnostic[], diagnostic: Diagnostic): void {
	if (
		!diagnostics.some(
			(item) =>
				item.code === diagnostic.code
				&& item.file === diagnostic.file
				&& item.message === diagnostic.message,
		)
	) {
		diagnostics.push(diagnostic);
	}
}

/**
 * Records names a source file binds through imports: Zod namespaces, Routa's
 * query helpers, and everything else as imported schemas.
 */
function readImport(
	statement: ts.ImportDeclaration,
	specifier: string,
	source: SchemaSource,
	resolvedFile: string | undefined,
): void {
	const clause = statement.importClause;

	if (!clause) {
		return;
	}

	const isZod = specifier === "zod" || specifier === "zod/v4";
	const isRouta = specifier === "@routa-ts/core" || specifier === "@routa-ts/core/query/helpers";

	if (clause.name) {
		(isZod ? source.zodNamespaces : source.imports).add(clause.name.text);
	}

	const bindings = clause.namedBindings;

	if (bindings && ts.isNamespaceImport(bindings)) {
		(isZod ? source.zodNamespaces : source.imports).add(bindings.name.text);
	}

	if (bindings && ts.isNamedImports(bindings)) {
		for (const element of bindings.elements) {
			const imported = element.propertyName?.text ?? element.name.text;

			if (isZod && imported === "z") {
				source.zodNamespaces.add(element.name.text);
			} else if (isZod && zodRegistryNames.has(imported)) {
				source.zodRegistries.add(element.name.text);
			} else if (isRouta && (imported === "Sort" || imported === "Fields")) {
				source.routaHelpers.set(element.name.text, imported);
			} else {
				source.imports.add(element.name.text);
				if (resolvedFile) source.importFiles.set(element.name.text, resolvedFile);
			}
		}
	}
}

/**
 * Returns the Zod factory a callee names, such as `string`, `coerce.number`,
 * or `iso.date`, or `undefined` when the callee is not on a Zod namespace.
 */
function zodFactory(callee: ts.Expression, source: SchemaSource): string | undefined {
	if (!ts.isPropertyAccessExpression(callee)) {
		return undefined;
	}

	const target = unwrapExpression(callee.expression);

	if (ts.isIdentifier(target) && source.zodNamespaces.has(target.text)) {
		return callee.name.text;
	}

	if (
		ts.isPropertyAccessExpression(target)
		&& ts.isIdentifier(target.expression)
		&& source.zodNamespaces.has(target.expression.text)
		&& (target.name.text === "coerce" || target.name.text === "iso")
	) {
		return `${target.name.text}.${callee.name.text}`;
	}

	return undefined;
}

function stringLiteral(expression: ts.Expression): string | undefined {
	const unwrapped = unwrapExpression(expression);
	return ts.isStringLiteralLike(unwrapped) ? unwrapped.text : undefined;
}

function numericLiteral(expression: ts.Expression | undefined): number | undefined {
	return expression && ts.isNumericLiteral(expression) ? Number(expression.text) : undefined;
}

/**
 * Reads a JSON value written as literals, or `undefined` when any part of it
 * is computed.
 */
function jsonLiteral(expression: ts.Expression): unknown {
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

	if (unwrapped.kind === ts.SyntaxKind.TrueKeyword) return true;
	if (unwrapped.kind === ts.SyntaxKind.FalseKeyword) return false;
	if (unwrapped.kind === ts.SyntaxKind.NullKeyword) return null;

	if (ts.isArrayLiteralExpression(unwrapped)) {
		const values = unwrapped.elements.map((element) => jsonLiteral(element));
		return values.some((value) => value === undefined) ? undefined : values;
	}

	if (ts.isObjectLiteralExpression(unwrapped)) {
		const result: Record<string, unknown> = {};

		for (const property of unwrapped.properties) {
			const key = ts.isPropertyAssignment(property) ? propertyName(property.name) : undefined;
			const value =
				key !== undefined && jsonLiteral((property as ts.PropertyAssignment).initializer);

			if (key === undefined || value === undefined) {
				return undefined;
			}

			result[key] = value;
		}

		return result;
	}

	return undefined;
}

const foldableKeys = new Set(["type", "properties", "required", "additionalProperties"]);

/**
 * Combines plain object members of an intersection into the one object they
 * describe together, or returns `undefined` when any member carries another
 * keyword (a `$ref`, a union, or metadata).
 */
function foldObjects(members: JsonSchema[]): JsonSchema | undefined {
	if (
		members.length < 2
		|| !members.every(
			(member) =>
				member.type === "object" && Object.keys(member).every((key) => foldableKeys.has(key)),
		)
	) {
		return undefined;
	}

	const properties: JsonSchema = {};
	const required = new Set<string>();

	for (const member of members) {
		for (const [key, value] of Object.entries(
			(member.properties as JsonSchema | undefined) ?? {},
		)) {
			if (Object.hasOwn(properties, key)) {
				continue;
			}

			const parts: JsonSchema[] = [];

			for (const other of members) {
				const part = (other.properties as JsonSchema | undefined)?.[key] as JsonSchema | undefined;

				if (part && !parts.some((seen) => stableJson(seen) === stableJson(part))) {
					parts.push(part);
				}
			}

			properties[key] = parts.length === 1 ? value : (foldObjects(parts) ?? { allOf: parts });
		}

		for (const key of (member.required as string[] | undefined) ?? []) {
			required.add(key);
		}
	}

	return {
		type: "object",
		...(required.size > 0 ? { required: [...required] } : {}),
		properties,
		...(members.every((member) => member.additionalProperties === false)
			? { additionalProperties: false }
			: {}),
	};
}

/**
 * Serializes a value with sorted object keys so equal schemas compare equal.
 */
function stableJson(value: unknown): string {
	return JSON.stringify(value, (_key, item: unknown) =>
		typeof item === "object" && item !== null && !Array.isArray(item)
			? Object.fromEntries(
					Object.entries(item).sort(([left], [right]) => left.localeCompare(right)),
				)
			: item,
	);
}

function readDeprecation(contract: ts.ObjectLiteralExpression): ProjectedOperation["deprecation"] {
	const value = objectLiteral(propertyValue(contract, "deprecation"));
	if (!value) return undefined;
	const string = (name: string) => {
		const item = propertyValue(value, name);
		return item ? stringLiteral(item) : undefined;
	};
	const sunset = string("sunset");
	const replacement = string("replacement");
	return sunset || replacement ? { sunset, replacement } : undefined;
}
