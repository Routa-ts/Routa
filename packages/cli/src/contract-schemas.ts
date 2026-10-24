import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	createRouteObject,
	objectLiteral,
	propertyName,
	propertyValue,
	routeConfigObject,
	unwrapExpression,
} from "./ast.js";
import {
	cookieDeclaration,
	type Diagnostic,
	middlewareContract,
	type MiddlewareMetadata,
	type RouteMetadata,
} from "./project.js";
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
	/**
	 * One Response Object per status, composed from the operation's effective outcomes: its route
	 * outcomes and the rejects of every middleware in its chain.
	 */
	responses: Map<number, ProjectedResponse>;
	deprecation?: { sunset?: string; replacement?: string };
};

/**
 * What one named outcome contributes to an OpenAPI Response Object.
 *
 * An outcome without a `schema` is intentionally bodyless.
 */
export type ProjectedResponse = {
	description: string;
	schema?: JsonSchema;
	headers?: Record<string, ProjectedHeader>;
	cookies?: ProjectedResponseCookie[];
	/**
	 * Every response at this status has at least one `Set-Cookie` field: each outcome under it
	 * requires some cookie, though not necessarily the same one.
	 */
	setCookieRequired?: true;
};

/**
 * A cookie as one outcome declares it: required when listed as `{ handle, required: true }`.
 * `declaration` names the `createCookie` declaration (`file#name`) behind the handle.
 */
export type ProjectedResponseCookie = ProjectedCookie & { required: boolean; declaration: string };

/** A handle's static facts and the `createCookie` declaration (`file#name`) they came from. */
type DeclaredCookie = ProjectedCookie & { declaration: string };

/** One named outcome that can end an operation: a route outcome or a middleware reject. */
type ProjectedOutcome = ProjectedResponse & {
	name: string;
	status: number;
	/** Who declares it, for messages: `the route` or `middleware <name>`. */
	producer: string;
	/** Names the outcome in messages, with its middleware when it is a reject. */
	label: string;
};

/** The operation a set of outcomes belongs to, for diagnostics. */
type OperationSite = { file: string; routePath: string; method: string };

/**
 * One declared response cookie: the static facts of its `createCookie` handle. No value is ever
 * part of the projection.
 */
export type ProjectedCookie = {
	name: string;
	httpOnly: boolean;
	secure: boolean;
	sameSite: "strict" | "lax" | "none";
	path: string;
	domain?: string;
	maxAge?: number;
	expires?: string;
	partitioned?: boolean;
};

/**
 * One declared response header, as an OpenAPI Header Object.
 */
export type ProjectedHeader = {
	required: boolean;
	description?: string;
	schema: JsonSchema;
};

/** What `routa check` knows from outside the route graph. */
export type ContractSchemaOptions = {
	/** Whether `src/routa.ts` turns lifecycle headers on. */
	lifecycleHeaders?: boolean;
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
 * @param options - Project facts the route graph does not hold
 * @returns Projected operations, components, and coded diagnostics
 */
export function projectContractSchemas(
	cwd: string,
	routes: readonly RouteMetadata[],
	parser: ts.SourceFileParser,
	options: ContractSchemaOptions = {},
): ContractSchemaProjection {
	const projector = new SchemaProjector(cwd, parser, options);
	const operations = new Map<string, Record<string, ProjectedOperation>>();

	for (const route of routes) {
		const contracts = projector.routeContracts(route.file, Object.keys(route.responses));
		const methods: Record<string, ProjectedOperation> = {};

		for (const method of Object.keys(route.responses)) {
			const contract = contracts[method];
			const site = { file: route.file, routePath: route.path, method };
			const rejects = projector.middlewareRejects(
				route.methodMiddleware[method] ?? route.middleware,
				site,
				contract?.lifecycle ?? { owned: new Set() },
			);
			methods[method] = {
				input: contract?.input ?? {},
				responses: projector.compose([...(contract?.outcomes ?? []), ...rejects], site),
				...(contract?.deprecation ? { deprecation: contract.deprecation } : {}),
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
	zodNamespaces: Set<string>;
	zodRegistries: Set<string>;
	routaHelpers: Map<string, "Sort" | "Fields">;
	fallback?: SchemaSource;
};

type Context = {
	source: SchemaSource;
	io: SchemaIo;
	/** Set inside a root `params`, `query`, `headers`, or `cookies` schema. */
	parameter?: boolean;
};

type ComponentIdentity = {
	key: string;
	explicit: boolean;
	identity: string;
	file: string;
	/** Where the declaration was read: a parameter, a request body, or a response. */
	placement: string;
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
	/** The component node a wrapper refers to, registered only when placed. */
	via?: SchemaNode;
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
 * Zod check factories, passed to `.check()`, that validate without changing
 * the value.
 */
const validationChecks = new Set([
	"endsWith",
	"gt",
	"gte",
	"includes",
	"length",
	"lowercase",
	"lt",
	"lte",
	"maxLength",
	"maxSize",
	"mime",
	"minLength",
	"minSize",
	"multipleOf",
	"negative",
	"nonnegative",
	"nonpositive",
	"positive",
	"property",
	"refine",
	"regex",
	"size",
	"startsWith",
	"superRefine",
	"uppercase",
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

const componentPrefix = "#/components/schemas/";

/** Whether an outcome always sends at least one cookie effect. */
function requiresCookie(outcome: ProjectedResponse): boolean {
	return outcome.cookies?.some((cookie) => cookie.required) ?? false;
}

/**
 * The single string, number, or boolean value a schema allows (a `const` or one-value `enum`), as
 * text, or `undefined` when it allows other values.
 */
function literalText(schema: JsonSchema): string | undefined {
	const value =
		"const" in schema
			? schema.const
			: Array.isArray(schema.enum) && schema.enum.length === 1
				? schema.enum[0]
				: undefined;

	return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
		? String(value)
		: undefined;
}

const unsupportedSuggestion =
	"Use a supported Zod construct: primitives, z.literal, z.enum, z.object, z.array, z.record, z.union, z.discriminatedUnion, z.intersection or .and(), .optional(), .nullable(), checks such as .min(), and .meta() or .describe().";

class SchemaProjector {
	readonly diagnostics: Diagnostic[] = [];
	private readonly sources = new Map<string, SchemaSource>();
	private readonly declarationNodes = new Map<string, SchemaNode>();
	private readonly inProgress = new Set<string>();
	private readonly components = new Map<string, ComponentIdentity & { content: JsonSchema }>();
	private readonly scannedRegistries = new Set<string>();
	private readonly cookieHandles = new Map<string, DeclaredCookie | null>();

	constructor(
		private readonly cwd: string,
		private readonly parser: ts.SourceFileParser,
		private readonly options: ContractSchemaOptions,
	) {}

	/**
	 * Projects the `createRoute` contracts declared in a route file.
	 */
	routeContracts(
		routeFile: string,
		methods: readonly string[],
	): Record<
		string,
		Pick<ProjectedOperation, "input" | "deprecation"> & {
			outcomes: ProjectedOutcome[];
			lifecycle: LifecycleOwnership;
		}
	> {
		const schemasFile = join(dirname(routeFile), "schemas.ts");
		const schemas = existsSync(join(this.cwd, schemasFile)) ? this.source(schemasFile) : undefined;
		const route = this.source(routeFile, schemas);
		const config = routeConfigObject(this.parse(routeFile));
		const contracts: ReturnType<SchemaProjector["routeContracts"]> = {};

		for (const method of methods) {
			const value = config && propertyValue(config, method);
			const contract = value && createRouteObject(value);

			if (!contract) {
				continue;
			}

			const lifecycle = this.lifecycleOwnedHeaders(contract, route);
			contracts[method] = {
				input: this.inputSchemas(contract, route),
				outcomes: this.outcomes(propertyValue(contract, "responses"), route, lifecycle),
				lifecycle,
				deprecation: readDeprecation(contract),
			};
		}

		return contracts;
	}

	/**
	 * Projects the rejects of every middleware in an operation's chain with the same reader as
	 * route outcomes, so they follow the same rules. Identifiers resolve against the middleware's
	 * own source file. The route's lifecycle headers apply to rejects too, and a HEAD operation
	 * forbids reject bodies like it forbids outcome bodies.
	 */
	middlewareRejects(
		middleware: readonly MiddlewareMetadata[],
		site: OperationSite,
		lifecycle: LifecycleOwnership,
	): ProjectedOutcome[] {
		const rejects: ProjectedOutcome[] = [];

		for (const item of middleware) {
			const declaration = middlewareContract(item);

			if (!declaration) {
				continue;
			}

			const source = this.source(declaration.file);
			const { contract } = declaration;
			// A spread after `rejects` (or with no `rejects` at all) can hide or replace them.
			const spread = contract.properties
				.slice(
					contract.properties.findIndex(
						(property) =>
							(ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property))
							&& propertyName(property.name) === "rejects",
					) + 1,
				)
				.find(ts.isSpreadAssignment);

			if (spread) {
				this.unsupported(
					spread,
					{ source, io: "output" },
					"middleware contracts need a static rejects property; a spread can hide or replace rejects",
				);
				continue;
			}

			const value = propertyValue(contract, "rejects");

			if (!value) {
				continue;
			}

			for (const reject of this.outcomes(value, source, lifecycle, item.name)) {
				if (site.method === "head" && reject.schema) {
					this.operationProblem(site, {
						code: "ROUTA_RESPONSE_BODYLESS_SCHEMA",
						message: `${reject.producer} reject "${reject.name}" declares a schema, but HEAD responses have no body`,
						suggestion:
							"Remove the reject's schema, or keep the middleware off the HEAD route. A reject reachable from a HEAD route cannot have a body.",
					});
				}

				rejects.push(reject);
			}
		}

		return rejects;
	}

	/**
	 * Composes an operation's effective outcomes into one Response Object per status.
	 *
	 * A status with one outcome keeps it. Outcomes that share a status compose only when every one
	 * has a body and they share a required property whose literal values all differ: the body
	 * becomes a `oneOf` of the alternatives with that property as the discriminator. Headers and
	 * cookies under the status must agree and project once. Alternatives are ordered by outcome
	 * name, so nothing depends on source order. Every other combination is a diagnostic.
	 */
	compose(
		outcomes: readonly ProjectedOutcome[],
		site: OperationSite,
	): Map<number, ProjectedResponse> {
		const byName = new Map<string, ProjectedOutcome>();
		const byStatus = new Map<number, ProjectedOutcome[]>();

		for (const outcome of outcomes) {
			const earlier = byName.get(outcome.name);

			if (earlier) {
				this.operationProblem(site, {
					code: "ROUTA_OUTCOME_NAME_COLLISION",
					message: `Outcome "${outcome.name}" is declared by ${earlier.producer} and by ${outcome.producer}`,
					suggestion:
						"Every outcome that can end an operation needs its own name, because the handler result names its outcome. Rename one of them.",
				});
				continue;
			}

			byName.set(outcome.name, outcome);
			byStatus.set(outcome.status, [...(byStatus.get(outcome.status) ?? []), outcome]);
		}

		return new Map(
			Array.from(byStatus.entries())
				.sort(([left], [right]) => left - right)
				.map(([status, alternatives]) => [
					status,
					this.composeStatus(
						[...alternatives].sort((left, right) => compareText(left.name, right.name)),
						status,
						site,
					),
				]),
		);
	}

	private composeStatus(
		alternatives: readonly ProjectedOutcome[],
		status: number,
		site: OperationSite,
	): ProjectedResponse {
		if (alternatives.length === 1) {
			const {
				name: _name,
				status: _status,
				producer: _producer,
				label: _label,
				...response
			} = alternatives[0]!;
			return {
				...response,
				...(requiresCookie(alternatives[0]!) ? { setCookieRequired: true } : {}),
			};
		}

		const list = (outcomes: readonly ProjectedOutcome[]) =>
			outcomes.map((outcome) => outcome.label).join(", ");
		const names = list(alternatives);
		const at = `${site.method.toUpperCase()} ${site.routePath} status ${status}`;
		const ambiguous = (message: string) =>
			this.operationProblem(site, {
				code: "ROUTA_RESPONSE_STATUS_AMBIGUOUS",
				message: `${at}: ${message}`,
				suggestion:
					'Give every body outcome under this status a required property with a different literal value (a literal discriminator such as kind: z.literal("created")), or use a distinct status for each outcome.',
			});
		const bodies = alternatives.filter((outcome) => outcome.schema);
		let schema: JsonSchema | undefined;

		if (bodies.length === 0) {
			ambiguous(`outcomes ${names} have no body, so they are indistinguishable to clients`);
		} else if (bodies.length < alternatives.length) {
			const bodyless = alternatives.filter((outcome) => !outcome.schema);
			ambiguous(`outcomes ${names} mix a body (${list(bodies)}) with no body (${list(bodyless)})`);
		} else {
			const discriminator = this.discriminator(bodies.map((outcome) => outcome.schema!));

			if (discriminator) {
				schema = { oneOf: bodies.map((outcome) => outcome.schema!), discriminator };
			} else {
				ambiguous(
					`body outcomes ${names} share no required property whose literal values all differ, so clients cannot tell them apart`,
				);
			}
		}

		const headers = this.composeHeaders(alternatives, site);
		const cookies = this.composeCookies(alternatives, site);

		return {
			description: alternatives
				.map((outcome) => `- \`${outcome.name}\`: ${outcome.description}`)
				.join("\n"),
			...(schema ? { schema } : {}),
			...(headers ? { headers } : {}),
			...(cookies ? { cookies } : {}),
			...(alternatives.every(requiresCookie) ? { setCookieRequired: true } : {}),
		};
	}

	/**
	 * The discriminator for same-status body alternatives: a property every alternative requires
	 * with a single literal value (string, number, or boolean), each value different as text,
	 * because discriminator values compare as strings. When several qualify, the
	 * lexicographically first name wins.
	 *
	 * A referenced alternative is matched implicitly by its component name. When any referenced
	 * alternative's value differs from its component name, `mapping` names every referenced
	 * alternative's component explicitly.
	 */
	private discriminator(
		schemas: readonly JsonSchema[],
	): { propertyName: string; mapping?: Record<string, string> } | undefined {
		const literals = schemas.map((schema) => this.requiredLiterals(schema));
		const [first, ...rest] = literals;
		const propertyName = Array.from(first?.keys() ?? [])
			.filter((name) => {
				const values = literals.map((properties) => properties.get(name));
				return (
					values.every((value) => value !== undefined) && new Set(values).size === values.length
				);
			})
			.sort(compareText)[0];

		if (rest.length === 0 || propertyName === undefined) {
			return undefined;
		}

		const referenced = schemas.flatMap((schema, index) =>
			typeof schema.$ref === "string" && schema.$ref.startsWith(componentPrefix)
				? [[literals[index]!.get(propertyName)!, schema.$ref] as const]
				: [],
		);
		const implicit = referenced.every(([value, ref]) => ref === `${componentPrefix}${value}`);

		return implicit ? { propertyName } : { propertyName, mapping: Object.fromEntries(referenced) };
	}

	/**
	 * Required properties that hold one string, number, or boolean literal, keyed by name with the
	 * literal as text. Reads through component references and `allOf` members, so a described or
	 * component-backed intersection keeps its literals. A property that members constrain to
	 * different literals has none.
	 */
	private requiredLiterals(schema: JsonSchema): Map<string, string> {
		const required = new Set<string>();
		const values = new Map<string, string | null>();
		const collect = (node: JsonSchema): void => {
			const object = this.resolved(node);

			for (const member of Array.isArray(object.allOf) ? (object.allOf as JsonSchema[]) : []) {
				collect(member);
			}

			if (object.type !== "object") {
				return;
			}

			for (const name of Array.isArray(object.required) ? (object.required as string[]) : []) {
				required.add(name);
			}

			for (const [name, property] of Object.entries(
				(object.properties ?? {}) as Record<string, JsonSchema>,
			)) {
				const value = literalText(this.resolved(property));
				const earlier = values.get(name);

				if (value !== undefined) {
					values.set(name, earlier === undefined || earlier === value ? value : null);
				}
			}
		};

		collect(schema);
		return new Map(
			Array.from(required).flatMap((name) => {
				const value = values.get(name);
				return typeof value === "string" ? [[name, value] as const] : [];
			}),
		);
	}

	/**
	 * Projects the headers of same-status alternatives once. One name must have one projected
	 * schema, compared by content so an inline schema and a reference to an equal component
	 * agree; the first alternative's spelling is kept. A header is required only when every
	 * alternative declares it required.
	 */
	private composeHeaders(
		alternatives: readonly ProjectedOutcome[],
		site: OperationSite,
	): Record<string, ProjectedHeader> | undefined {
		const headers: Record<string, ProjectedHeader> = {};
		const owners = new Map<string, ProjectedOutcome>();

		for (const outcome of alternatives) {
			for (const [name, header] of Object.entries(outcome.headers ?? {})) {
				const earlier = owners.get(name);

				if (!earlier) {
					owners.set(name, outcome);
					headers[name] = header;
					continue;
				}

				if (
					stableJson(this.resolved(earlier.headers![name]!.schema))
					!== stableJson(this.resolved(header.schema))
				) {
					this.operationProblem(site, {
						code: "ROUTA_RESPONSE_HEADER_INCOMPATIBLE",
						message: `Header "${name}" has different schemas in outcomes ${earlier.label} and ${outcome.label}, which share status ${outcome.status}`,
						suggestion:
							"Outcomes under one status document one Header Object per name. Declare the header with the same schema and metadata in both, or use distinct statuses.",
					});
				}
			}
		}

		for (const [name, header] of Object.entries(headers)) {
			const required = alternatives.every((outcome) => outcome.headers?.[name]?.required);
			const { required: _required, ...rest } = header;
			headers[name] = { ...rest, required };
		}

		return Object.keys(headers).length > 0 ? headers : undefined;
	}

	/**
	 * Lists the cookies of same-status alternatives once. One identity must come from one
	 * `createCookie` declaration; it is always set only when every alternative requires that
	 * identity. Whether `Set-Cookie` itself is always present is `setCookieRequired`.
	 */
	private composeCookies(
		alternatives: readonly ProjectedOutcome[],
		site: OperationSite,
	): ProjectedResponseCookie[] | undefined {
		const cookies = new Map<string, { cookie: ProjectedResponseCookie; owner: ProjectedOutcome }>();

		for (const outcome of alternatives) {
			for (const cookie of outcome.cookies ?? []) {
				const identity = cookieIdentity(cookie);
				const earlier = cookies.get(identity);

				if (!earlier) {
					cookies.set(identity, { cookie, owner: outcome });
				} else if (earlier.cookie.declaration !== cookie.declaration) {
					this.operationProblem(site, {
						code: "ROUTA_RESPONSE_COOKIE_CONFLICT",
						message: `Cookie ${describeCookie(cookie)} comes from different createCookie declarations in outcomes ${earlier.owner.label} and ${outcome.label}, which share status ${outcome.status}`,
						suggestion:
							"A cookie identity (name, domain, and path) has one declaration. Share one createCookie handle between the outcomes, or use distinct statuses.",
					});
				}
			}
		}

		const composed = Array.from(cookies.values(), ({ cookie }) => ({
			...cookie,
			required: alternatives.every((outcome) =>
				outcome.cookies?.some(
					(item) => cookieIdentity(item) === cookieIdentity(cookie) && item.required,
				),
			),
		}));

		return composed.length > 0 ? composed : undefined;
	}

	/** Reports a problem with an operation's composed outcomes, at the route file. */
	private operationProblem(
		site: OperationSite,
		diagnostic: { code: string; message: string; suggestion: string },
	): void {
		pushUnique(this.diagnostics, {
			...diagnostic,
			severity: "error",
			file: site.file,
			routePath: site.routePath,
		});
	}

	/**
	 * Returns every component registered while projecting, sorted by key.
	 */
	componentSchemas(): Record<string, JsonSchema> {
		return Object.fromEntries(
			Array.from(this.components.entries())
				.sort(([left], [right]) => compareText(left, right))
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

			const node = this.node(expression, { source, io: "input", parameter: name !== "body" });
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

	/**
	 * Reads a record of named outcomes: a route's `responses`, or a middleware's `rejects` when
	 * `middleware` names it. Both follow the same declaration rules, so a reject gets every check
	 * a route outcome gets.
	 */
	private outcomes(
		value: ts.Expression | undefined,
		source: SchemaSource,
		lifecycleOwned: LifecycleOwnership,
		middleware?: string,
	): ProjectedOutcome[] {
		const responses = objectLiteral(value);
		const context: Context = { source, io: "output" };
		const kind = middleware === undefined ? "route" : "middleware";
		const producer = middleware === undefined ? "the route" : `middleware ${middleware}`;
		const result: ProjectedOutcome[] = [];

		if (value && !responses) {
			this.unsupported(
				value,
				context,
				kind === "route"
					? "route responses need an inline object of outcomes"
					: "middleware rejects need an inline object of outcomes",
			);
		}

		for (const response of responses?.properties ?? []) {
			const outcome = ts.isPropertyAssignment(response)
				? objectLiteral(response.initializer)
				: undefined;
			const status = outcome && numericLiteral(propertyValue(outcome, "status"));

			if (
				!outcome
				|| status === undefined
				|| outcome.properties.some(
					(property) =>
						!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property),
				)
			) {
				this.unsupported(
					response,
					context,
					`${kind === "route" ? "route outcomes" : "middleware rejects"} need static status and schema properties without spreads`,
				);
				continue;
			}

			const description = propertyValue(outcome, "description");
			const text = description && stringLiteral(description);

			if (description && text === undefined) {
				this.unsupported(description, context, "outcome descriptions need a string literal");
			}

			const name = ts.isPropertyAssignment(response) ? propertyName(response.name) : undefined;

			if (name === undefined) {
				this.unsupported(response, context, "outcome names need an identifier or string literal");
				continue;
			}

			const schema = propertyValue(outcome, "schema");
			const headers = propertyValue(outcome, "headers");
			const projectedHeaders = headers
				? this.responseHeaders(headers, context, lifecycleOwned)
				: undefined;
			const cookies = propertyValue(outcome, "cookies");
			const projectedCookies = cookies ? this.responseCookies(cookies, context) : undefined;

			result.push({
				name,
				status,
				producer,
				label:
					middleware === undefined
						? `"${name}"`
						: `"${name}" (a reject of middleware ${middleware})`,
				description: text ?? humanizeOutcomeName(name),
				...(schema ? { schema: this.materialize(this.node(schema, context)) } : {}),
				...(projectedHeaders ? { headers: projectedHeaders } : {}),
				...(projectedCookies?.length ? { cookies: projectedCookies } : {}),
			});
		}

		return result;
	}

	/**
	 * The header names the response lifecycle owns on a route: none unless lifecycle headers are on
	 * and the route declares a `deprecation`; then `deprecation` and `sunset`, plus `link` when
	 * the deprecation names a replacement.
	 *
	 * The deprecation may be an inline object or a local constant. When it is neither, whether the
	 * lifecycle owns `link` cannot be known, so `unreadable` carries the expression to report.
	 */
	private lifecycleOwnedHeaders(
		contract: ts.ObjectLiteralExpression,
		source: SchemaSource,
	): LifecycleOwnership {
		const deprecation = propertyValue(contract, "deprecation");

		if (!this.options.lifecycleHeaders || !deprecation) {
			return { owned: new Set() };
		}

		const object = this.localObject(deprecation, source);

		if (!object || object.properties.some((property) => ts.isSpreadAssignment(property))) {
			return { owned: new Set(["deprecation", "sunset"]), unreadable: deprecation };
		}

		return {
			owned: new Set([
				"deprecation",
				"sunset",
				...(propertyValue(object, "replacement") ? ["link"] : []),
			]),
		};
	}

	/** Resolves an expression to an object literal, following local constants in the same file. */
	private localObject(
		expression: ts.Expression,
		source: SchemaSource,
	): ts.ObjectLiteralExpression | undefined {
		const seen = new Set<string>();
		let current = unwrapExpression(expression);

		while (ts.isIdentifier(current) && !seen.has(current.text)) {
			seen.add(current.text);
			const declaration = source.declarations.get(current.text);

			if (!declaration) {
				return undefined;
			}

			current = unwrapExpression(declaration.initializer);
		}

		return objectLiteral(current);
	}

	/**
	 * Projects an outcome's `headers` declaration into Header Objects and reports declarations
	 * Routa cannot honor: names that are not lowercase, collide in case, or belong to Routa or the
	 * lifecycle, and values that are not strings, numbers, or booleans.
	 */
	private responseHeaders(
		expression: ts.Expression,
		context: Context,
		lifecycle: LifecycleOwnership,
	): Record<string, ProjectedHeader> | undefined {
		const schema = this.structure(this.node(expression, { ...context, parameter: true }));
		const properties = schema.properties as Record<string, JsonSchema> | undefined;

		if (schema.type !== "object" || typeof properties !== "object") {
			if (Object.keys(schema).length > 0) {
				this.report(context.source, expression, {
					code: "ROUTA_SCHEMA_UNSUPPORTED",
					message: "Response headers must be an object schema keyed by header name",
					suggestion: "Declare headers with z.object({ ... }).",
				});
			}

			return undefined;
		}

		const required = new Set((schema.required as string[] | undefined) ?? []);
		const names = new Map<string, string>();
		const headers: Record<string, ProjectedHeader> = {};

		for (const [name, value] of Object.entries(properties)) {
			const lower = name.toLowerCase();
			const earlier = names.get(lower);
			const fail = (code: string, message: string, suggestion: string) =>
				this.report(context.source, expression, { code, message, suggestion });

			if (earlier !== undefined) {
				fail(
					"ROUTA_RESPONSE_HEADER_COLLISION",
					`Response headers "${earlier}" and "${name}" differ only in case`,
					"Header identity is case-insensitive and has one owner. Declare the header once, in lowercase.",
				);
				continue;
			}

			names.set(lower, name);

			if (!/^[!#$%&'*+\-.^_`|~0-9a-z]+$/.test(lower)) {
				fail(
					"ROUTA_RESPONSE_HEADER_NAME",
					`Response header "${name}" is not a valid header name`,
					"Use a header name made of letters, digits, and the characters ! # $ % & ' * + - . ^ _ ` | ~.",
				);
			} else if (lower === "set-cookie") {
				fail(
					"ROUTA_RESPONSE_HEADER_RESERVED",
					`Response header "${name}" is reserved: Routa owns Set-Cookie`,
					"Declare response cookies as cookies, not as a header. Routa serializes Set-Cookie itself.",
				);
			} else if (reservedHeaderNames.has(lower)) {
				fail(
					"ROUTA_RESPONSE_HEADER_RESERVED",
					`Response header "${name}" is reserved: Routa owns ${lower}`,
					`Remove ${lower} from headers. Routa sets it from the response body and transport.`,
				);
			} else if (lifecycle.owned.has(lower)) {
				fail(
					"ROUTA_RESPONSE_HEADER_LIFECYCLE",
					`Response header "${name}" is owned by the route's lifecycle headers`,
					"Remove it from headers, or turn lifecycleHeaders off. Routa writes deprecation, sunset, and the successor link itself.",
				);
			} else if (name !== lower) {
				fail(
					"ROUTA_RESPONSE_HEADER_NAME",
					`Header "${name}" must be declared in lowercase ("${lower}")`,
					`Rename it to "${lower}". Header names are lowercase in Routa contracts.`,
				);
			}

			if (lower === "link" && lifecycle.unreadable) {
				this.report(context.source, lifecycle.unreadable, {
					code: "ROUTA_SCHEMA_UNSUPPORTED",
					message:
						"Route deprecation needs a static object with literal properties, so Routa cannot tell whether lifecycle headers own the link header",
					suggestion:
						"Write deprecation as an inline object or a local constant, or stop declaring a link header on this route.",
				});
			}

			if (!this.isScalarValue(value)) {
				fail(
					"ROUTA_RESPONSE_HEADER_VALUE",
					`Header "${name}" must be a string, number, or boolean`,
					"Declare a string, number, or boolean schema (or a literal or enum of them). Routa does not serialize other header values.",
				);
			}

			const description = value.description ?? this.resolved(value).description;
			headers[name] = {
				required: required.has(name),
				...(typeof description === "string" ? { description } : {}),
				schema: value,
			};
		}

		return headers;
	}

	/**
	 * Projects an outcome's `cookies` declaration: the static facts of each handle. Reports handles
	 * Routa cannot resolve, and declarations that list one identity twice (an error) or one name in
	 * several scopes (a warning).
	 */
	private responseCookies(
		expression: ts.Expression,
		context: Context,
	): ProjectedResponseCookie[] | undefined {
		const list = unwrapExpression(expression);

		if (!ts.isArrayLiteralExpression(list)) {
			this.unresolvedCookie(
				expression,
				context.source,
				"cookies must be an array literal of createCookie handles",
			);
			return undefined;
		}

		const cookies: ProjectedResponseCookie[] = [];
		const identities = new Map<string, ProjectedCookie>();

		for (const element of list.elements) {
			const entry = this.cookieEntry(element, context.source);

			if (entry === undefined) {
				continue;
			}

			// A declaration Routa found but could not accept was reported where it is declared.
			if (entry.handle === null) {
				continue;
			}

			const identity = cookieIdentity(entry.handle);

			if (identities.has(identity)) {
				this.report(context.source, list, {
					code: "ROUTA_RESPONSE_COOKIE_CONFLICT",
					message: `Outcome declares cookie ${describeCookie(entry.handle)} more than once`,
					suggestion:
						"A cookie identity (name, domain, and path) has one owner. Declare it once per outcome.",
				});
				continue;
			}

			identities.set(identity, entry.handle);
			cookies.push({ ...entry.handle, required: entry.required });
		}

		const byName = new Map<string, ProjectedCookie[]>();

		for (const cookie of cookies) {
			byName.set(cookie.name, [...(byName.get(cookie.name) ?? []), cookie]);
		}

		for (const [name, scoped] of byName) {
			if (scoped.length > 1) {
				this.report(context.source, list, {
					code: "ROUTA_RESPONSE_COOKIE_SCOPE",
					severity: "warning",
					message: `Cookies named "${name}" have different scopes: ${scoped.map(describeCookie).join(", ")}`,
					suggestion:
						"They are separate cookies, which clients can confuse. Give them different names unless the scopes are intended.",
				});
			}
		}

		return cookies;
	}

	/**
	 * Reads one `cookies` entry: a handle identifier (optional) or `{ handle, required: true }`.
	 * Reports an entry Routa cannot read and returns `undefined`; `handle: null` means the
	 * declaration was found and reported as invalid.
	 */
	private cookieEntry(
		element: ts.Expression,
		source: SchemaSource,
	): { handle: DeclaredCookie | null; required: boolean } | undefined {
		const entry = unwrapExpression(element);

		if (ts.isIdentifier(entry)) {
			const handle = this.cookieHandle(entry.text, source);

			if (handle === undefined) {
				this.unresolvedCookie(element, source, "cookies must be createCookie handles");
				return undefined;
			}

			return { handle, required: false };
		}

		if (!ts.isObjectLiteralExpression(entry)) {
			this.unresolvedCookie(element, source, "cookies must be createCookie handles");
			return undefined;
		}

		const unreadable = entry.properties.find(isUnreadableProperty);

		if (unreadable) {
			this.report(source, unreadable, {
				code: "ROUTA_RESPONSE_COOKIE_STATIC",
				message: "A required cookie entry must be a literal { handle, required: true }",
				suggestion: cookieEntryReminder,
			});
			return undefined;
		}

		const required = propertyValue(entry, "required");
		const handleNode = propertyValue(entry, "handle");
		const handleName =
			handleNode && ts.isIdentifier(unwrapExpression(handleNode))
				? (unwrapExpression(handleNode) as ts.Identifier).text
				: undefined;

		if (required && !isLiteralToken(required)) {
			this.report(source, required, {
				code: "ROUTA_RESPONSE_COOKIE_STATIC",
				message: "A required cookie entry must write required as the literal true",
				suggestion: cookieEntryReminder,
			});
			return undefined;
		}

		if (
			entry.properties.length !== 2
			|| !handleName
			|| !required
			|| unwrapExpression(required).kind !== ts.SyntaxKind.TrueKeyword
		) {
			this.unresolvedCookie(
				element,
				source,
				"a cookie entry must be a createCookie handle or { handle, required: true }",
			);
			return undefined;
		}

		const handle = this.cookieHandle(handleName, source);

		if (handle === undefined) {
			this.unresolvedCookie(element, source, "cookies must be createCookie handles");
			return undefined;
		}

		return { handle, required: true };
	}

	private unresolvedCookie(node: ts.Node, source: SchemaSource, what: string): void {
		this.report(source, node, {
			code: "ROUTA_RESPONSE_COOKIE_UNRESOLVED",
			message: `Routa cannot read a cookie declaration: ${what}`,
			suggestion:
				"List identifiers declared with createCookie({ ... }) in this file or imported from a relative module or re-export.",
		});
	}

	/**
	 * Finds a handle's `createCookie` declaration, in the route file or the schemas file beside
	 * it, and reads its static facts once. `undefined` means no declaration was found; `null` means
	 * one was found and reported as invalid.
	 */
	private cookieHandle(name: string, source: SchemaSource): DeclaredCookie | null | undefined {
		for (const file of [source.file, source.fallback?.file]) {
			const declaration = file && cookieDeclaration(this.cwd, file, name, this.parser);

			if (declaration) {
				const key = `${declaration.file}#${declaration.name}`;

				if (!this.cookieHandles.has(key)) {
					const cookie = this.readCookie(declaration.contract, declaration.file);
					this.cookieHandles.set(key, cookie ? { ...cookie, declaration: key } : null);
				}

				return this.cookieHandles.get(key);
			}
		}

		return undefined;
	}

	/**
	 * Reads one `createCookie` configuration. Every attribute is a contract fact, so each must be
	 * a literal; the same rules as `createCookie` then apply.
	 */
	private readCookie(
		config: ts.ObjectLiteralExpression,
		file: string,
	): ProjectedCookie | undefined {
		const source = this.source(file);
		let readable = true;
		const fail = (code: string, node: ts.Node, message: string, suggestion: string): undefined => {
			readable = false;
			this.report(source, node, { code, message, suggestion });
			return undefined;
		};
		const attribute = (code: string, node: ts.Node, key: string, expected: string): undefined =>
			fail(
				code,
				node,
				`Cookie attribute ${key} ${expected}`,
				`Fix ${key} in createCookie({ ... }). ${cookieRuleReminder}`,
			);
		const literalSuggestion =
			"Routa reads cookie names and attributes from source without running it. Write each one as a literal in createCookie({ ... }).";

		const hasSpread = config.properties.some(isUnreadableProperty);

		for (const property of config.properties) {
			if (isUnreadableProperty(property)) {
				fail(
					"ROUTA_RESPONSE_COOKIE_STATIC",
					property,
					"Cookie attributes must be literal properties without spreads or computed names",
					literalSuggestion,
				);
			}
		}

		const text = (key: string, required: boolean) => {
			const value = propertyValue(config, key);

			if (!value) {
				if (required && !hasSpread) {
					attribute("ROUTA_RESPONSE_COOKIE_ATTRIBUTE", config, key, "is required");
				}

				return undefined;
			}

			const literal = stringLiteral(value);

			if (literal === undefined) {
				const code = isLiteralToken(value)
					? key === "name"
						? "ROUTA_RESPONSE_COOKIE_NAME"
						: "ROUTA_RESPONSE_COOKIE_ATTRIBUTE"
					: "ROUTA_RESPONSE_COOKIE_STATIC";
				return code === "ROUTA_RESPONSE_COOKIE_STATIC"
					? fail(code, value, `Cookie ${key} must be a literal`, literalSuggestion)
					: attribute(code, value, key, "must be a string");
			}

			return literal;
		};
		const flag = (key: string, required: boolean) => {
			const value = propertyValue(config, key);

			if (!value) {
				if (required && !hasSpread) {
					attribute("ROUTA_RESPONSE_COOKIE_ATTRIBUTE", config, key, "is required");
				}

				return undefined;
			}

			const unwrapped = unwrapExpression(value);

			if (unwrapped.kind === ts.SyntaxKind.TrueKeyword) return true;
			if (unwrapped.kind === ts.SyntaxKind.FalseKeyword) return false;

			return isLiteralToken(unwrapped)
				? attribute("ROUTA_RESPONSE_COOKIE_ATTRIBUTE", value, key, "must be true or false")
				: fail(
						"ROUTA_RESPONSE_COOKIE_STATIC",
						value,
						`Cookie ${key} must be a literal`,
						literalSuggestion,
					);
		};

		const name = text("name", true);
		const httpOnly = flag("httpOnly", true);
		const secure = flag("secure", true);
		const sameSite = text("sameSite", true);
		const path = text("path", true);
		const domain = text("domain", false);
		const expires = text("expires", false);
		const partitioned = flag("partitioned", false);
		const maxAgeValue = propertyValue(config, "maxAge");
		let maxAge: number | undefined;

		if (maxAgeValue) {
			maxAge = signedNumber(maxAgeValue);

			if (maxAge === undefined) {
				if (isLiteralToken(maxAgeValue)) {
					attribute("ROUTA_RESPONSE_COOKIE_ATTRIBUTE", maxAgeValue, "maxAge", "must be a number");
				} else {
					fail(
						"ROUTA_RESPONSE_COOKIE_STATIC",
						maxAgeValue,
						"Cookie maxAge must be a literal",
						literalSuggestion,
					);
				}
			}
		}

		const nameNode = propertyValue(config, "name") ?? config;

		if (name !== undefined && !cookieNamePattern.test(name)) {
			fail(
				"ROUTA_RESPONSE_COOKIE_NAME",
				nameNode,
				"Cookie name must be a valid cookie name",
				"Use letters, digits, and the characters ! # $ % & ' * + - . ^ _ ` | ~. A name cannot be empty or contain spaces, semicolons, commas, or equals signs.",
			);
		}

		const check = (key: string, value: unknown, valid: boolean, expected: string) => {
			if (value !== undefined && !valid) {
				attribute(
					"ROUTA_RESPONSE_COOKIE_ATTRIBUTE",
					propertyValue(config, key) ?? config,
					key,
					expected,
				);
			}
		};

		check(
			"sameSite",
			sameSite,
			["strict", "lax", "none"].includes(sameSite ?? ""),
			'must be "strict", "lax", or "none"',
		);
		check(
			"path",
			path,
			cookiePathPattern.test(path ?? ""),
			'must start with "/", end without a space, and use only printable ASCII without ";" (write non-ASCII characters percent-encoded)',
		);
		check("domain", domain, cookieDomainPattern.test(domain ?? ""), "must be a valid host name");
		check(
			"maxAge",
			maxAge,
			Number.isSafeInteger(maxAge) && (maxAge ?? 0) >= 0,
			"must be a non-negative whole number of seconds",
		);
		check(
			"expires",
			expires,
			isIsoDateTime(expires ?? ""),
			'must be an ISO 8601 date-time such as "2030-01-01T00:00:00Z"',
		);

		const schemaExpression = propertyValue(config, "schema");

		if (!schemaExpression) {
			if (!hasSpread) {
				attribute("ROUTA_RESPONSE_COOKIE_ATTRIBUTE", config, "schema", "is required");
			}
		} else {
			const schema = this.materialize(this.node(schemaExpression, { source, io: "output" }));

			if (!this.isScalarValue(schema)) {
				fail(
					"ROUTA_RESPONSE_COOKIE_VALUE",
					schemaExpression,
					"Cookie value must be a string, number, or boolean",
					"Declare a string, number, or boolean schema (or a literal or enum of them). Routa encodes only those values.",
				);
			}
		}

		if (
			!readable
			|| name === undefined
			|| httpOnly === undefined
			|| secure === undefined
			|| !sameSite
			|| !path
		) {
			return undefined;
		}

		const rule = cookieRuleProblem({ name, secure, sameSite, path, domain, partitioned });

		if (rule) {
			fail("ROUTA_RESPONSE_COOKIE_RULE", nameNode, rule, cookieRuleReminder);
			return undefined;
		}

		return {
			name,
			httpOnly,
			secure,
			sameSite: sameSite as ProjectedCookie["sameSite"],
			path,
			...(domain === undefined ? {} : { domain }),
			...(maxAge === undefined ? {} : { maxAge }),
			...(expires === undefined ? {} : { expires }),
			...(partitioned === undefined ? {} : { partitioned }),
		};
	}

	/**
	 * Follows `$ref`s through the components registered so far, so an exported wrapper of an
	 * exported schema reads as what it stands for. Each reference's sibling metadata applies over
	 * its target, the nearest winning, and a cycle stops at the reference that repeats.
	 */
	private resolved(schema: JsonSchema, seen: ReadonlySet<string> = new Set()): JsonSchema {
		const key = typeof schema.$ref === "string" ? schema.$ref.replace(componentPrefix, "") : undefined;
		const target = key === undefined || seen.has(key) ? undefined : this.components.get(key);

		if (!key || !target) {
			return schema;
		}

		const { $ref: _ref, ...siblings } = schema;
		return { ...this.resolved(target.content, new Set(seen).add(key)), ...siblings };
	}

	/** Whether a projected schema accepts only strings, numbers, and booleans. */
	private isScalarValue(schema: JsonSchema): boolean {
		const value = this.resolved(schema);
		const scalarTypes = ["string", "number", "integer", "boolean"];
		const isScalar = (item: unknown) =>
			typeof item === "string" || typeof item === "number" || typeof item === "boolean";

		if (Array.isArray(value.anyOf) || Array.isArray(value.oneOf) || Array.isArray(value.allOf)) {
			const members = (value.anyOf ?? value.oneOf ?? value.allOf) as JsonSchema[];
			return members.every((member) => this.isScalarValue(member));
		}

		if (Array.isArray(value.enum)) {
			return value.enum.every(isScalar);
		}

		if ("const" in value) {
			return isScalar(value.const);
		}

		const types = Array.isArray(value.type) ? value.type : [value.type];
		return types.every((type) => typeof type === "string" && scalarTypes.includes(type));
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
		const schema = this.structure(node);

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
			zodNamespaces: new Set(),
			zodRegistries: new Set(),
			routaHelpers: new Map(),
			fallback,
		};

		for (const statement of ast.statements) {
			if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
				const specifier = statement.moduleSpecifier.text;
				readImport(statement, specifier, source);
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

		const key = `${declaration.source.file}#${name}#${context.io}${context.parameter ? "#parameter" : ""}`;
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
					placement: placementOf(context),
				},
			};
		}

		this.declarationNodes.set(key, node);
		return node;
	}

	private factory(name: string, call: ts.CallExpression, context: Context): SchemaNode {
		const [first, second] = call.arguments;

		if (Object.hasOwn(stringFormats, name)) {
			if (name === "url" || name === "httpUrl") {
				this.checkUrlOptions(call, first, context);
			}

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
			case "record":
				return first && second
					? this.record(this.node(first, context), this.node(second, context), call, context)
					: this.missing(call, context);
			case "union":
				return this.union(call, first, context);
			case "discriminatedUnion":
				return this.discriminatedUnion(call, context);
			case "intersection":
				return first && second
					? this.intersection([this.node(first, context), this.node(second, context)], context)
					: this.missing(call, context);
			case "optional":
			case "nullable":
			case "nullish":
				return first ? this.wrapper(name, this.node(first, context)) : this.missing(call, context);
			case "stringbool":
				// Parameters follow the convention where `type: boolean` means the
				// strings "true" and "false". A JSON body receives the string itself.
				return this.mutation(
					call,
					context,
					"z.stringbool()",
					plainNode({ type: context.io === "input" && !context.parameter ? "string" : "boolean" }),
				);
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
					? this.pipe(this.node(first, context), second, context)
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
				this.classifyCheck(argument, context, new Set());
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
			if (name === "url") {
				this.checkUrlOptions(call, first, context);
			}

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
			return first ? this.pipe(receiver(), first, context) : this.missing(call, context);
		}

		if (name === "and") {
			return first
				? this.intersection([receiver(), this.node(first, context)], context)
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
	 *
	 * Zod rejects unknown keys of an intersection only when every member is
	 * closed, so a closed member kept in `allOf` is inlined open, and the whole
	 * closes only when every member does. A root parameter container folds
	 * through references and documentation, which parameters have no place for.
	 */
	private intersection(nodes: SchemaNode[], context: Context): SchemaNode {
		const shapes = nodes.map((node) => this.shape(node));
		const closed = shapes.every(isClosed);
		const parameters = context.parameter && foldObjects(shapes.flatMap(flattenAllOf));

		if (parameters) {
			return plainNode(parameters);
		}

		const members = nodes.flatMap((node, index) =>
			flattenAllOf(
				isClosed(shapes[index])
					? { ...opened(shapes[index]), ...this.documentation(node) }
					: this.materialize(node),
			),
		);
		const folded = foldObjects(members);

		return plainNode(
			folded
				? { ...folded, ...(closed ? { additionalProperties: false } : {}) }
				: { allOf: members, ...(closed ? { unevaluatedProperties: false } : {}) },
		);
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

	/**
	 * Projects `from.pipe(to)`. Input reads the incoming side, so a readable
	 * `from` decides it alone. Output documents `to`; the pipe itself never
	 * changes a value, so any mutation is reported by the side that makes it.
	 */
	private pipe(from: SchemaNode, toExpression: ts.Expression, context: Context): SchemaNode {
		return context.io === "input" && !from.opaque ? from : this.node(toExpression, context);
	}

	/**
	 * Projects `z.record(key, value)`. Key constraints become `propertyNames`,
	 * and an exhaustive key set such as `z.enum()` makes every key required.
	 */
	private record(
		key: SchemaNode,
		value: SchemaNode,
		call: ts.CallExpression,
		context: Context,
	): SchemaNode {
		const keySchema = this.structure(key);

		if (Object.keys(keySchema).length === 0) {
			// The key was already reported as unreadable.
			return plainNode({ type: "object", additionalProperties: this.materialize(value) });
		}

		const keyOptions = Array.isArray(keySchema.anyOf)
			? (keySchema.anyOf as JsonSchema[])
			: [keySchema];

		if (keyOptions.some((option) => option.type !== "string")) {
			return this.unsupported(call, context, "z.record() keys must be string schemas");
		}

		const propertyNames = this.materialize(key);
		const names = keyOptions.flatMap((option) =>
			Array.isArray(option.enum) ? option.enum : "const" in option ? [option.const] : [undefined],
		);

		return plainNode({
			type: "object",
			...(stableJson(propertyNames) === stableJson({ type: "string" }) ? {} : { propertyNames }),
			...(names.every((name) => typeof name === "string") ? { required: names } : {}),
			additionalProperties: this.materialize(value),
		});
	}

	/**
	 * Reports a `.check()` argument that rewrites the value, following local
	 * declarations, or one Routa cannot classify.
	 */
	private classifyCheck(expression: ts.Expression, context: Context, seen: Set<Declaration>): void {
		const check = unwrapExpression(expression);

		if (ts.isArrowFunction(check) || ts.isFunctionExpression(check)) {
			return;
		}

		const declaration = ts.isIdentifier(check) ? lookup(context.source, check.text) : undefined;

		if (declaration && !seen.has(declaration)) {
			seen.add(declaration);
			this.classifyCheck(declaration.initializer, { ...context, source: declaration.source }, seen);
			return;
		}

		const factory = ts.isCallExpression(check)
			? zodFactory(unwrapExpression(check.expression), context.source)
			: undefined;

		if (factory && valueMutatingMethods.has(factory)) {
			this.reportMutation(check, context, `z.${factory}()`);
		} else if (!factory || !validationChecks.has(factory)) {
			this.unsupported(
				check,
				context,
				"Routa cannot tell whether this check changes values",
				"Pass .check() a Zod check such as z.minLength(1) or an inline function, declared in the same file.",
			);
		}
	}

	/**
	 * Reports URL options that normalize response values, or options Routa
	 * cannot read.
	 */
	private checkUrlOptions(
		call: ts.CallExpression,
		options: ts.Expression | undefined,
		context: Context,
	): void {
		if (context.io !== "output") {
			return;
		}

		const normalize = urlNormalize(options, context.source, new Set());

		if (normalize === true) {
			this.reportMutation(call, context, "URL normalization");
		} else if (normalize === undefined) {
			this.unsupported(
				call,
				context,
				"Routa cannot tell whether these URL options normalize the value",
				"Write URL options as an object literal with a literal normalize value.",
			);
		}
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
						placement: placementOf(context),
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
			...(receiver.via ? { via: receiver.via } : {}),
		};
	}

	/**
	 * A Zod wrapper that projects as its inner schema, keeping the inner
	 * schema's component reference.
	 */
	private passthrough(inner: SchemaNode): SchemaNode {
		return inner.component
			? {
					schema: { $ref: `#/components/schemas/${inner.component.key}` },
					meta: {},
					optional: inner.optional,
					via: inner,
				}
			: { ...inner };
	}

	private content(node: SchemaNode): JsonSchema {
		return { ...node.schema, ...node.meta };
	}

	/**
	 * The structural keywords a node stands for, looking through component
	 * references and leaving out documentation.
	 */
	private shape(node: SchemaNode): JsonSchema {
		return node.via ? this.shape(node.via) : node.schema;
	}

	/**
	 * The documentation a node carries, including what it inherits through
	 * component references.
	 */
	private documentation(node: SchemaNode): JsonSchema {
		return node.via ? { ...this.documentation(node.via), ...node.meta } : node.meta;
	}

	/**
	 * The structural schema a node stands for, looking through wrappers of
	 * components instead of returning their `$ref`.
	 */
	private structure(node: SchemaNode): JsonSchema {
		return node.via ? this.structure(node.via) : this.content(node);
	}

	/**
	 * Places a node in a document: a component reference when it owns a key,
	 * otherwise the inline schema.
	 */
	private materialize(node: SchemaNode): JsonSchema {
		if (node.via) {
			this.materialize(node.via);
		}

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
			if (stableJson(existing.content) !== stableJson(content)) {
				const [first, second] = [existing.placement, component.placement].sort();
				pushUnique(this.diagnostics, {
					code: "ROUTA_SCHEMA_COMPONENT_COLLISION",
					severity: "error",
					message: `Schema ${component.key} in ${component.file} projects differently as ${first} and as ${second}, so it cannot be one OpenAPI component.`,
					file: component.file,
					suggestion:
						"Declare one schema for each placement, or change the schema so it projects the same way everywhere. Routa never picks one projection.",
				});
			}

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

	private unsupported(
		node: ts.Node,
		context: Context,
		detail: string,
		suggestion = unsupportedSuggestion,
	): SchemaNode {
		this.report(context.source, node, {
			code: "ROUTA_SCHEMA_UNSUPPORTED",
			message: `Unsupported schema for OpenAPI (${detail})`,
			suggestion,
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

const cookieNamePattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const cookiePathPattern = /^\/(?:[\x20-\x3a\x3c-\x7e]*[\x21-\x3a\x3c-\x7e])?$/;
const cookieDomainPattern =
	/^\.?[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*$/;
const isoDateTimePattern =
	/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;
/** Whether a string is an ISO 8601 date-time naming a real calendar moment. */
function isIsoDateTime(value: string): boolean {
	const match = isoDateTimePattern.exec(value);

	if (!match) {
		return false;
	}

	const [year, month, day, hour, minute, second] = match.slice(1, 7).map(Number) as [
		number,
		number,
		number,
		number,
		number,
		number,
	];
	const date = new Date(0);
	date.setUTCFullYear(year, month - 1, day);
	const offsetHour = match[7] === undefined ? 0 : Number(match[7]);
	const offsetMinute = match[8] === undefined ? 0 : Number(match[8]);

	return (
		date.getUTCFullYear() === year
		&& date.getUTCMonth() === month - 1
		&& date.getUTCDate() === day
		&& hour < 24
		&& minute < 60
		&& second < 60
		&& offsetHour < 24
		&& offsetMinute < 60
	);
}

const cookieEntryReminder =
	"Write cookies: [{ handle: session, required: true }] for a cookie the outcome must always set or clear, and list a bare handle for an optional one.";

const cookieRuleReminder =
	'SameSite=None and Partitioned need secure: true. A __Secure- name needs secure: true. A __Host- name needs secure: true, path: "/", and no domain.';

/**
 * The first cookie rule a declaration breaks, in the order `createCookie` checks them at runtime.
 */
function cookieRuleProblem(cookie: {
	name: string;
	secure: boolean;
	sameSite: string;
	path: string;
	domain?: string;
	partitioned?: boolean;
}): string | undefined {
	if (cookie.sameSite === "none" && !cookie.secure) {
		return "Cookie sets SameSite=None, which requires secure: true";
	}

	if (cookie.partitioned && !cookie.secure) {
		return "Cookie sets Partitioned, which requires secure: true";
	}

	const prefix = cookie.name.toLowerCase();

	if (prefix.startsWith("__secure-") && !cookie.secure) {
		return "Cookie uses the __Secure- prefix, which requires secure: true";
	}

	if (prefix.startsWith("__host-")) {
		if (!cookie.secure) return "Cookie uses the __Host- prefix, which requires secure: true";
		if (cookie.path !== "/") return 'Cookie uses the __Host- prefix, which requires path: "/"';
		if (cookie.domain !== undefined)
			return "Cookie uses the __Host- prefix, which forbids a domain";
	}

	return undefined;
}

/** The identity of a cookie: name, domain without case or a leading dot, and path. */
function cookieIdentity(cookie: { name: string; domain?: string; path: string }): string {
	return `${cookie.name}\0${(cookie.domain ?? "").toLowerCase().replace(/^\./, "")}\0${cookie.path}`;
}

function describeCookie(cookie: { name: string; domain?: string; path: string }): string {
	return `"${cookie.name}" (${cookie.domain ? `Domain=${cookie.domain}; ` : ""}Path=${cookie.path})`;
}

/** Whether an object property is a spread, a method, or has a computed name. */
function isUnreadableProperty(property: ts.ObjectLiteralElementLike): boolean {
	return (
		ts.isSpreadAssignment(property)
		|| (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property))
		|| !propertyName(property.name)
	);
}

/** Whether an expression is a literal token (string, number, boolean, null), not a computed value. */
function isLiteralToken(expression: ts.Expression): boolean {
	const unwrapped = unwrapExpression(expression);
	return (
		ts.isStringLiteralLike(unwrapped)
		|| ts.isNumericLiteral(unwrapped)
		|| unwrapped.kind === ts.SyntaxKind.TrueKeyword
		|| unwrapped.kind === ts.SyntaxKind.FalseKeyword
		|| unwrapped.kind === ts.SyntaxKind.NullKeyword
		|| (ts.isPrefixUnaryExpression(unwrapped) && ts.isNumericLiteral(unwrapped.operand))
	);
}

/** Reads a numeric literal, including a leading minus. */
function signedNumber(expression: ts.Expression): number | undefined {
	const unwrapped = unwrapExpression(expression);

	if (
		ts.isPrefixUnaryExpression(unwrapped)
		&& unwrapped.operator === ts.SyntaxKind.MinusToken
		&& ts.isNumericLiteral(unwrapped.operand)
	) {
		return -Number(unwrapped.operand.text);
	}

	return numericLiteral(unwrapped);
}

/** The header names the lifecycle owns on a route, and a deprecation expression that could not be read. */
type LifecycleOwnership = { owned: ReadonlySet<string>; unreadable?: ts.Expression };

/** Header names Routa owns on every response. */
const reservedHeaderNames = new Set([
	"content-type",
	"content-length",
	"transfer-encoding",
	"connection",
	"set-cookie",
]);

function placementOf(context: Context): string {
	if (context.io === "output") return "a response";
	return context.parameter ? "a parameter" : "a request body";
}

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

/**
 * Reads whether URL factory options enable `normalize`, following local
 * declarations, or returns `undefined` when the options are not literal.
 */
function urlNormalize(
	expression: ts.Expression | undefined,
	source: SchemaSource,
	seen: Set<Declaration>,
): boolean | undefined {
	const options = expression && unwrapExpression(expression);

	if (!options || ts.isStringLiteralLike(options)) {
		return false;
	}

	const declaration = ts.isIdentifier(options) ? lookup(source, options.text) : undefined;

	if (declaration && !seen.has(declaration)) {
		seen.add(declaration);
		return urlNormalize(declaration.initializer, declaration.source, seen);
	}

	if (!ts.isObjectLiteralExpression(options)) {
		return undefined;
	}

	let normalize: boolean | undefined = false;

	for (const property of options.properties) {
		if (!ts.isPropertyAssignment(property) || propertyName(property.name) === undefined) {
			return undefined;
		}

		if (propertyName(property.name) === "normalize") {
			const value = jsonLiteral(property.initializer);
			normalize = typeof value === "boolean" ? value : undefined;
		}
	}

	return normalize;
}

/**
 * Turns an outcome name into the sentence used when it declares no description:
 * `notFound` becomes "Not found".
 */
export function humanizeOutcomeName(name: string): string {
	const words = name
		.replaceAll(/([a-z0-9])([A-Z])/g, "$1 $2")
		.replaceAll(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.split(/[\s_-]+/)
		.filter((word) => word.length > 0)
		.map((word) => word.toLowerCase());
	const sentence = words.join(" ");
	return sentence.charAt(0).toUpperCase() + sentence.slice(1);
}

function stringLiteral(expression: ts.Expression): string | undefined {
	const unwrapped = unwrapExpression(expression);
	return ts.isStringLiteralLike(unwrapped) ? unwrapped.text : undefined;
}

function numericLiteral(expression: ts.Expression | undefined): number | undefined {
	const unwrapped = expression && unwrapExpression(expression);
	return unwrapped && ts.isNumericLiteral(unwrapped) ? Number(unwrapped.text) : undefined;
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
 * Whether a schema rejects keys it does not declare: a strict object, or a
 * composition closed with `unevaluatedProperties: false`.
 */
function isClosed(schema: JsonSchema): boolean {
	return (
		(schema.type === "object" && schema.additionalProperties === false)
		|| schema.unevaluatedProperties === false
	);
}

/**
 * The same schema with its closedness removed, for placement in `allOf`.
 */
function opened(schema: JsonSchema): JsonSchema {
	return Object.fromEntries(
		Object.entries(schema).filter(
			([key, value]) =>
				!(key === "additionalProperties" || key === "unevaluatedProperties") || value !== false,
		),
	);
}

/**
 * The members of a bare `allOf`, so nested intersections flatten.
 */
function flattenAllOf(schema: JsonSchema): JsonSchema[] {
	return Array.isArray(schema.allOf) && Object.keys(schema).length === 1
		? (schema.allOf as JsonSchema[])
		: [schema];
}

/**
 * Combines plain object members of an intersection into the one object they
 * describe together, or returns `undefined` when any member carries another
 * keyword (a `$ref`, a union, metadata, or typed additional properties).
 */
function foldObjects(members: JsonSchema[]): JsonSchema | undefined {
	if (
		members.length < 2
		|| !members.every(
			(member) =>
				member.type === "object"
				&& Object.keys(member).every((key) => foldableKeys.has(key))
				&& (member.additionalProperties === undefined || member.additionalProperties === false),
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
			? Object.fromEntries(Object.entries(item).sort(([left], [right]) => compareText(left, right)))
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

/** Orders names by UTF-16 code units, the same everywhere, unlike locale-aware comparison. */
function compareText(left: string, right: string): number {
	return left < right ? -1 : left > right ? 1 : 0;
}
