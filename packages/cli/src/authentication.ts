import { existsSync } from "node:fs";
import { join } from "node:path";
import { objectLiteral, propertyName, unwrapExpression } from "./ast.js";
import { boundDeclaration, exportedDeclarations, parseTypeScriptFile } from "./declarations.js";
import type { Diagnostic, MiddlewareMetadata } from "./project.js";
import { routaConfigMember, spreadObject } from "./services.js";
import * as ts from "./typescript.js";

/** One credential scheme `src/routa.ts` declares, read from source. */
export type AuthenticationSchemeMetadata = {
	name: string;
	/** The static challenge realm, when the scheme overrides it. */
	realm?: string;
} & (
	| { kind: "bearer" }
	| {
			kind: "apiKey";
			/** As written; HTTP compares header names case-insensitively. */ header: string;
	  }
	| { kind: "sessionCookie"; cookie: string }
);

/** The application's authentication contract facts. */
export type AuthenticationMetadata = {
	/** In priority order, which is declaration order unless `priority` sets it. */
	schemes: AuthenticationSchemeMetadata[];
	multipleCredentials: "priority" | "reject";
};

/** What a `requireAuth` guard contributes to a middleware chain's metadata. */
export type AuthenticationRequirementMetadata = {
	/** The schemes the guard allows, resolved against the configured ones. */
	schemes: string[];
};

const configFile = "src/routa.ts";
const coreModule = "@routa-ts/core";
/** Scheme names are OpenAPI security scheme keys, so they follow the component key rule. */
// A leading letter also keeps names out of JavaScript's integer-key ordering, so scheme order is
// the same in source, at runtime, and in generated metadata.
const schemeNamePattern = /^[a-zA-Z][a-zA-Z0-9.\-_]*$/;
/** Printable ASCII without `"` or `\`, as `bearer()` checks at runtime. */
const realmPattern = /^[\x20\x21\x23-\x5b\x5d-\x7e]+$/;

export const authenticationRequiredDescription =
	"Authentication is required: the request presented no credential.";
export const authenticationFailedDescription =
	"Authentication failed: the request presented a credential that is malformed, unsupported, or rejected.";
export const ambiguousCredentialsDescription =
	"Ambiguous credentials: the request presented credentials of more than one scheme the operation accepts.";

/** RFC 9110 `token`, the grammar of header names and, in RFC 6265, of cookie names. */
const tokenNamePattern = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

type SchemeKind = AuthenticationSchemeMetadata["kind"];

/** Each kind's constructor, and the auth-scheme its challenges name. */
const kinds: Record<SchemeKind, { call: string; challenge: string; article: string }> = {
	bearer: { call: "bearer", challenge: "Bearer", article: "A" },
	apiKey: { call: "apiKey", challenge: "ApiKey", article: "An" },
	sessionCookie: { call: "sessionCookie", challenge: "Session", article: "A" },
};

/**
 * Reads the `authentication` field of the `createRouta` config in `src/routa.ts` without
 * executing it. Scheme names, descriptor kinds, and challenge overrides are contract facts, so a
 * declaration Routa cannot read is an error, not an empty contract.
 *
 * @returns The scheme facts when authentication is declared and readable, and diagnostics
 */
export function applicationAuthentication(
	cwd: string,
	parser: ts.SourceFileParser,
): {
	authentication?: AuthenticationMetadata;
	diagnostics: Diagnostic[];
	warnings: Diagnostic[];
} {
	if (!existsSync(join(cwd, configFile))) {
		return { diagnostics: [], warnings: [] };
	}

	const { declaration, hidden } = routaConfigMember(cwd, parser, "authentication");
	// Like services: a config Routa cannot read may only hold tuning values, so this is no error.
	// Startup still rejects authentication that routa generate could not read.
	const warnings: Diagnostic[] = hidden
		? [
				{
					code: "ROUTA_AUTH_SPREAD_UNRESOLVED",
					severity: "warning",
					message: `The createRouta config in ${configFile} has a spread, computed key, or config argument that cannot be statically read, so authentication inside it cannot be read.`,
					file: configFile,
					suggestion:
						"Declare authentication as a visible member of the createRouta object, after any spread, or spread a const object literal. Startup rejects authentication that routa generate could not read.",
				},
			]
		: [];

	if (!declaration) {
		return { diagnostics: [], warnings };
	}

	const diagnostics: Diagnostic[] = [];
	const report = (code: string, message: string, suggestion: string, file = declaration.file) =>
		diagnostics.push({ code, severity: "error", message, file, suggestion });
	const unresolved = (message: string, file?: string) =>
		report(
			"ROUTA_AUTH_CONFIG_UNRESOLVED",
			message,
			"Write authentication as an object literal in createRouta, with a plain key for each scheme and a bearer({ ... }) call, or a const bound to one, as its value. routa generate reads these contract facts without running src/routa.ts.",
			file,
		);
	const config = readObject(cwd, declaration.file, declaration.node, parser);

	if (!config || hasUnreadableMember(config.object)) {
		unresolved(`The authentication config in ${configFile} cannot be statically read.`);
		return { diagnostics, warnings };
	}

	if (!memberNode(config.object, "principal")) {
		report(
			"ROUTA_AUTH_CONFIG_INVALID",
			`The authentication config in ${configFile} declares no principal schema.`,
			"Add principal: a Zod schema whose output has string id and type fields.",
			config.file,
		);
	}

	const schemesNode = memberNode(config.object, "schemes");
	const schemes = schemesNode && readObject(cwd, config.file, schemesNode, parser);

	if (!schemes || hasUnreadableMember(schemes.object)) {
		unresolved(
			`The authentication schemes in ${configFile} cannot be statically read.`,
			config.file,
		);
		return { diagnostics, warnings };
	}

	const metadata: AuthenticationSchemeMetadata[] = [];
	const names: string[] = [];

	for (const property of schemes.object.properties) {
		// hasUnreadableMember already rejected every other member kind.
		const member = property as ts.PropertyAssignment | ts.ShorthandPropertyAssignment;
		const name = propertyName(member.name) as string;
		names.push(name);

		if (!schemeNamePattern.test(name)) {
			report(
				"ROUTA_AUTH_CONFIG_INVALID",
				`Authentication scheme name "${name}" must start with a letter and use only letters, digits, ".", "-", and "_".`,
				"Rename the scheme. Its name is the OpenAPI security scheme key.",
				schemes.file,
			);
			continue;
		}

		const value = memberNode(schemes.object, name) as ts.Expression;
		const descriptor = schemeDescriptor(cwd, schemes.file, value, parser);

		if (!descriptor) {
			unresolved(
				`Authentication scheme "${name}" in ${configFile} is not a statically readable bearer(), apiKey(), or sessionCookie() call.`,
				schemes.file,
			);
			continue;
		}

		const transport = schemeTransport(descriptor.kind, descriptor.options);

		if ("problem" in transport) {
			report(
				transport.code,
				`Authentication scheme "${name}" ${transport.problem}`,
				transport.suggestion,
				descriptor.file,
			);
			continue;
		}

		const challenge = schemeChallenge(descriptor.kind, descriptor.options);

		if ("problem" in challenge) {
			report(
				"ROUTA_AUTH_CHALLENGE_INVALID",
				`Authentication scheme "${name}" ${challenge.problem}`,
				'Write the override as a literal, such as challenge: { realm: "api" }, with printable ASCII and no " or \\.',
				descriptor.file,
			);
			continue;
		}

		const scheme = {
			name,
			...transport,
			...(challenge.realm === undefined ? {} : { realm: challenge.realm }),
		} as AuthenticationSchemeMetadata;
		const overlap = transportOverlap(scheme, metadata);

		if (overlap) {
			report("ROUTA_AUTH_TRANSPORT_OVERLAP", overlap.message, overlap.suggestion, schemes.file);
			continue;
		}

		metadata.push(scheme);
	}

	if (schemes.object.properties.length === 0) {
		report(
			"ROUTA_AUTH_CONFIG_INVALID",
			`The authentication config in ${configFile} declares no credential schemes.`,
			"Declare a scheme, such as schemes: { userToken: bearer({ authenticate }) }.",
			schemes.file,
		);
	}

	const priority = schemePriority(config.object, names);
	const multipleCredentials = multipleCredentialsMode(config.object);

	for (const problem of [...priority.problems, ...multipleCredentials.problems]) {
		report(problem.code, problem.message, problem.suggestion, config.file);
	}

	return diagnostics.length > 0
		? { diagnostics, warnings }
		: {
				authentication: {
					schemes: priority.order.map((name) => metadata.find((item) => item.name === name)!),
					multipleCredentials: multipleCredentials.mode,
				},
				diagnostics,
				warnings,
			};
}

type ConfigProblem = { code: string; message: string; suggestion: string };

/**
 * Reads `priority`: absent for declaration order, or a literal list naming every scheme exactly
 * once.
 *
 * @param names - The declared scheme names, in declaration order
 */
function schemePriority(
	config: ts.ObjectLiteralExpression,
	names: readonly string[],
): { order: string[]; problems: ConfigProblem[] } {
	const node = memberNode(config, "priority");

	if (!node) {
		return { order: [...names], problems: [] };
	}

	const listed = ts.isExpression(node) ? stringList(node) : undefined;
	const at = `The authentication priority in ${configFile}`;
	const suggestion = `List every scheme exactly once, in the order Routa selects among presented credentials: priority: [${names.map((name) => JSON.stringify(name)).join(", ")}].`;

	if (!listed) {
		return {
			order: [],
			problems: [
				{
					code: "ROUTA_AUTH_CONFIG_UNRESOLVED",
					message: `${at} is not a literal list of scheme names.`,
					suggestion,
				},
			],
		};
	}

	const problems: ConfigProblem[] = [];

	for (const [index, name] of listed.entries()) {
		if (!names.includes(name)) {
			problems.push({
				code: "ROUTA_AUTH_SCHEME_UNKNOWN",
				message: `${at} lists "${name}", which schemes does not declare.`,
				suggestion,
			});
		} else if (listed.indexOf(name) !== index) {
			problems.push({
				code: "ROUTA_AUTH_PRIORITY_INVALID",
				message: `${at} lists "${name}" more than once.`,
				suggestion,
			});
		}
	}

	for (const name of names.filter((item) => !listed.includes(item))) {
		problems.push({
			code: "ROUTA_AUTH_PRIORITY_INVALID",
			message: `${at} omits "${name}".`,
			suggestion,
		});
	}

	return { order: listed, problems };
}

/** Reads `multipleCredentials`: absent for `"priority"`, or the literal `"priority"` or `"reject"`. */
function multipleCredentialsMode(config: ts.ObjectLiteralExpression): {
	mode: "priority" | "reject";
	problems: ConfigProblem[];
} {
	const node = memberNode(config, "multipleCredentials");
	const value = node && ts.isExpression(node) ? unwrapExpression(node) : undefined;
	const at = `The authentication multipleCredentials in ${configFile}`;
	const suggestion =
		'Write multipleCredentials: "priority" to authenticate the first presented credential by priority, or "reject" to answer ambiguousCredentials (400).';

	if (!node) {
		return { mode: "priority", problems: [] };
	}

	if (!value || !ts.isStringLiteralLike(value)) {
		return {
			mode: "priority",
			problems: [
				{
					code: "ROUTA_AUTH_CONFIG_UNRESOLVED",
					message: `${at} is not the literal "priority" or "reject".`,
					suggestion,
				},
			],
		};
	}

	if (value.text !== "priority" && value.text !== "reject") {
		return {
			mode: "priority",
			problems: [
				{
					code: "ROUTA_AUTH_CONFIG_INVALID",
					message: `${at} is ${JSON.stringify(value.text)}. Use "priority" or "reject".`,
					suggestion,
				},
			],
		};
	}

	return { mode: value.text, problems: [] };
}

/** The string literals an array literal lists, or `undefined` when it is anything else. */
function stringList(expression: ts.Expression): string[] | undefined {
	const array = unwrapExpression(expression);

	if (!ts.isArrayLiteralExpression(array)) {
		return undefined;
	}

	const values: string[] = [];

	for (const element of array.elements) {
		const value = unwrapExpression(element as ts.Expression);

		if (!ts.isStringLiteralLike(value)) {
			return undefined;
		}

		values.push(value.text);
	}

	return values;
}

/**
 * Reads where a scheme's credential travels: nothing more for Bearer, a literal header name for
 * an API key, or a literal cookie name for a session.
 */
function schemeTransport(
	kind: SchemeKind,
	options: ts.ObjectLiteralExpression,
):
	| { kind: "bearer" }
	| { kind: "apiKey"; header: string }
	| { kind: "sessionCookie"; cookie: string }
	| { code: string; problem: string; suggestion: string } {
	if (kind === "bearer") {
		return { kind };
	}

	const [key, noun, example, grammar] =
		kind === "apiKey"
			? (["header", "header", "x-api-key", "an HTTP header name"] as const)
			: (["cookie", "cookie", "session", "a cookie name"] as const);
	const node = memberNode(options, key);
	const value = node && ts.isExpression(node) ? unwrapExpression(node) : undefined;
	const suggestion = `Write the ${noun} name as a string literal of letters, digits, and !#$%&'*+-.^_\`|~, such as ${key}: "${example}".`;

	if (!value || !ts.isStringLiteralLike(value)) {
		return {
			code: "ROUTA_AUTH_CONFIG_UNRESOLVED",
			problem: `declares a ${noun} that is not a string literal.`,
			suggestion,
		};
	}

	if (!tokenNamePattern.test(value.text)) {
		return {
			code: "ROUTA_AUTH_CONFIG_INVALID",
			problem: `declares ${noun} ${JSON.stringify(value.text)}, which is not ${grammar}.`,
			suggestion,
		};
	}

	return kind === "apiKey" ? { kind, header: value.text } : { kind, cookie: value.text };
}

/** Why a scheme reads bytes another built-in scheme already reads, or `undefined`. */
function transportOverlap(
	scheme: AuthenticationSchemeMetadata,
	earlier: readonly AuthenticationSchemeMetadata[],
): { message: string; suggestion: string } | undefined {
	const header = scheme.kind === "apiKey" ? scheme.header.toLowerCase() : undefined;

	if (header === "authorization") {
		return {
			message: `Authentication scheme "${scheme.name}" reads the Authorization header, which carries Authorization-scheme credentials such as Bearer.`,
			suggestion:
				"Use bearer() for Bearer tokens, or read the API key from its own header, such as x-api-key.",
		};
	}

	if (header === "cookie") {
		return {
			message: `Authentication scheme "${scheme.name}" reads the Cookie header, which carries cookies.`,
			suggestion:
				"Use sessionCookie() for a session cookie, or read the API key from its own header, such as x-api-key.",
		};
	}

	const other = earlier.find(
		(item) =>
			item.kind === scheme.kind
			&& (item.kind !== "apiKey" || item.header.toLowerCase() === header)
			&& (item.kind !== "sessionCookie" || item.cookie === (scheme as { cookie?: string }).cookie),
	);

	if (!other) {
		return undefined;
	}

	const both = `Authentication schemes "${other.name}" and "${scheme.name}" both read`;
	return scheme.kind === "bearer"
		? {
				message: `${both} the Authorization Bearer credential.`,
				suggestion:
					"Declare one Bearer scheme, and verify every token format it accepts in its authenticator.",
			}
		: scheme.kind === "apiKey"
			? {
					message: `${both} the ${header} header.`,
					suggestion:
						"Declare one API-key scheme per header, and verify every key format it accepts in its authenticator.",
				}
			: {
					message: `${both} the "${scheme.cookie}" cookie.`,
					suggestion:
						"Declare one session scheme per cookie, and verify every session format it accepts in its authenticator.",
				};
}

/** A node read as an object literal: written in place, or a `const` bound to one. */
function readObject(
	cwd: string,
	file: string,
	node: ts.Node,
	parser: ts.SourceFileParser,
): { file: string; object: ts.ObjectLiteralExpression } | undefined {
	return ts.isExpression(node) ? spreadObject(cwd, file, node, parser, 0) : undefined;
}

/**
 * Whether an object has a spread, computed key, method, or accessor that could hide a fact.
 *
 * @param methods - Whether a method with a plain name is readable, as in descriptor options
 */
function hasUnreadableMember(object: ts.ObjectLiteralExpression, methods = false): boolean {
	return object.properties.some(
		(property) =>
			!(
				ts.isPropertyAssignment(property)
				|| ts.isShorthandPropertyAssignment(property)
				|| (methods && ts.isMethodDeclaration(property))
			) || propertyName(property.name) === undefined,
	);
}

/** The value of a named member, including a shorthand one, or the method that declares it. */
function memberNode(object: ts.ObjectLiteralExpression, name: string): ts.Node | undefined {
	for (const property of object.properties) {
		if (ts.isPropertyAssignment(property) && propertyName(property.name) === name) {
			return property.initializer;
		}

		if (ts.isShorthandPropertyAssignment(property) && propertyName(property.name) === name) {
			return property.name;
		}

		if (ts.isMethodDeclaration(property) && propertyName(property.name) === name) {
			return property;
		}
	}
}

/**
 * Follows a scheme value to its `bearer({ ... })`, `apiKey({ ... })`, or `sessionCookie({ ... })`
 * call, through `const` bindings and imports.
 */
function schemeDescriptor(
	cwd: string,
	file: string,
	expression: ts.Expression,
	parser: ts.SourceFileParser,
): { file: string; kind: SchemeKind; options: ts.ObjectLiteralExpression } | undefined {
	const read = (node: ts.Expression) => {
		for (const kind of Object.keys(kinds) as SchemeKind[]) {
			const call = coreCall(node, kinds[kind].call);
			const options = call && objectLiteral(call.arguments[0]);

			// A spread or computed key could hide or replace a contract fact. A method, such as
			// authenticate(token) { ... }, declares a function, which is never a contract fact.
			if (call) {
				return options && !hasUnreadableMember(options, true) ? { kind, options } : undefined;
			}
		}

		return undefined;
	};
	const node = unwrapExpression(expression);

	if (ts.isIdentifier(node)) {
		const bound = boundDeclaration(cwd, file, node.text, parser, read);
		return bound && { file: bound.file, ...bound.contract };
	}

	const descriptor = read(node);
	return descriptor && { file, ...descriptor };
}

/** Reads a challenge override: absent, or a literal object with only a literal realm. */
function schemeChallenge(
	kind: SchemeKind,
	options: ts.ObjectLiteralExpression,
): { realm?: string } | { problem: string } {
	const node = memberNode(options, "challenge");

	if (!node) {
		return {};
	}

	const challenge = objectLiteral(node);

	if (!challenge || hasUnreadableMember(challenge)) {
		return { problem: "declares a challenge override that is not a literal object." };
	}

	let realm: string | undefined;

	for (const property of challenge.properties) {
		const key = propertyName((property as ts.PropertyAssignment).name);

		if (key !== "realm") {
			return {
				problem: `declares challenge "${key}". ${kinds[kind].article} ${kinds[kind].challenge} challenge override accepts only realm.`,
			};
		}

		const value = ts.isPropertyAssignment(property)
			? unwrapExpression(property.initializer)
			: undefined;

		if (!value || !ts.isStringLiteralLike(value)) {
			return { problem: "declares a challenge realm that is not a string literal." };
		}

		if (!realmPattern.test(value.text)) {
			return {
				problem:
					'declares a challenge realm that is empty or has a character outside printable ASCII, " or \\.',
			};
		}

		realm = value.text;
	}

	return realm === undefined ? {} : { realm };
}

/**
 * The call when an expression calls a function its module imports from `@routa-ts/core` under
 * `name`, such as `bearer` or `requireAuth`, possibly aliased. An application function that
 * shares the name is not the core one.
 */
export function coreCall(expression: ts.Expression, name: string): ts.CallExpression | undefined {
	const node = unwrapExpression(expression);

	if (!ts.isCallExpression(node)) {
		return undefined;
	}

	const callee = unwrapExpression(node.expression);

	if (!ts.isIdentifier(callee)) {
		return undefined;
	}

	for (const statement of node.getSourceFile().statements) {
		if (
			ts.isImportDeclaration(statement)
			&& ts.isStringLiteral(statement.moduleSpecifier)
			&& statement.moduleSpecifier.text === coreModule
			&& statement.importClause?.namedBindings
			&& ts.isNamedImports(statement.importClause.namedBindings)
			&& statement.importClause.namedBindings.elements.some(
				(element) =>
					element.name.text === callee.text
					&& (element.propertyName?.text ?? element.name.text) === name,
			)
		) {
			return node;
		}
	}

	return undefined;
}

/**
 * Reads an inline `requireAuth(...)` guard as middleware metadata, resolving its allowed schemes
 * against the configured ones. Returns `undefined` for any other expression.
 *
 * @param file - The route file the guard is written in, relative to the project root
 */
export function requireAuthMiddleware(
	expression: ts.Expression,
	file: string,
	authentication: AuthenticationMetadata | undefined,
): { metadata: MiddlewareMetadata; diagnostics: Diagnostic[] } | undefined {
	const call = coreCall(expression, "requireAuth");

	if (!call) {
		return undefined;
	}

	const diagnostics: Diagnostic[] = [];
	const report = (code: string, message: string, suggestion: string) =>
		diagnostics.push({ code, severity: "error", message, file, suggestion });
	const configured = authentication?.schemes.map((scheme) => scheme.name) ?? [];
	const requested = requestedSchemes(call);

	if (!authentication) {
		report(
			"ROUTA_AUTH_NOT_CONFIGURED",
			`requireAuth() in ${file} needs authentication, but ${configFile} configures none.`,
			"Configure authentication in createRouta with a principal schema and a credential scheme, or remove requireAuth().",
		);
	} else if (requested === "unresolved") {
		report(
			"ROUTA_AUTH_REQUIREMENT_UNRESOLVED",
			`requireAuth() in ${file} declares options that cannot be statically read.`,
			'Call requireAuth() for any scheme, or list scheme names inline: requireAuth({ schemes: ["userToken"] }).',
		);
	} else if (requested?.length === 0) {
		report(
			"ROUTA_AUTH_REQUIREMENT_EMPTY",
			`requireAuth() in ${file} allows no schemes, so no request could pass it.`,
			"List at least one scheme, or call requireAuth() to accept any configured scheme.",
		);
	} else {
		for (const name of requested ?? []) {
			if (!configured.includes(name)) {
				report(
					"ROUTA_AUTH_SCHEME_UNKNOWN",
					`requireAuth() in ${file} allows scheme "${name}", which ${configFile} does not declare.`,
					`Use a declared scheme: ${configured.map((item) => JSON.stringify(item)).join(", ")}.`,
				);
			}
		}
	}

	return {
		metadata: {
			file,
			name: "requireAuth",
			requires: [],
			provides: [],
			providesTypes: {},
			rejects: [
				{
					type: "authenticationRequired",
					status: 401,
					description: authenticationRequiredDescription,
				},
			],
			security: [],
			permissions: [],
			authentication: {
				schemes: Array.isArray(requested)
					? requested.filter((name) => configured.includes(name))
					: configured,
			},
		},
		diagnostics,
	};
}

/**
 * The scheme names a `requireAuth` call lists: `undefined` without options, or `unresolved` when
 * the options are not an inline literal list of names.
 */
function requestedSchemes(call: ts.CallExpression): string[] | "unresolved" | undefined {
	if (call.arguments.length === 0) {
		return undefined;
	}

	const options = call.arguments.length === 1 ? objectLiteral(call.arguments[0]) : undefined;

	if (!options || hasUnreadableMember(options) || options.properties.length !== 1) {
		return "unresolved";
	}

	const list = memberNode(options, "schemes");
	const array = list && ts.isExpression(list) ? unwrapExpression(list) : undefined;

	if (!array || !ts.isArrayLiteralExpression(array)) {
		return "unresolved";
	}

	const names: string[] = [];

	for (const element of array.elements) {
		const value = unwrapExpression(element as ts.Expression);

		if (!ts.isStringLiteralLike(value)) {
			return "unresolved";
		}

		names.push(value.text);
	}

	return names;
}

/**
 * Reports a `requireAuth` guard a filesystem `middleware.ts` exports. Folder requirements are not
 * supported yet, and an export Routa does not read would never run, leaving its routes public.
 *
 * @param file - The middleware file, relative to the project root
 */
export function filesystemRequirementDiagnostics(
	cwd: string,
	file: string,
	parser: ts.SourceFileParser,
): Diagnostic[] {
	const sourceFile = parseTypeScriptFile(join(cwd, file), parser);
	const guards = exportedDeclarations(cwd, file, sourceFile, parser, (expression) =>
		coreCall(expression, "requireAuth") ? true : undefined,
	);

	return guards.map((guard) => ({
		code: "ROUTA_AUTH_REQUIREMENT_UNSUPPORTED",
		severity: "error",
		message: `${file} exports requireAuth() as ${guard.exportedName}, but folder middleware cannot require authentication yet, so it would not run.`,
		file,
		suggestion: "Write requireAuth() inline in the middleware of each route or method it protects.",
	}));
}

/**
 * The schemes an operation accepts, in priority order: those every `requireAuth` guard in its
 * middleware chain allows, or every configured scheme without a guard. Generated types, route
 * metadata, and OpenAPI all read an operation's accepted schemes from here.
 */
export function allowedSchemes(
	chain: readonly MiddlewareMetadata[],
	authentication: AuthenticationMetadata,
): string[] {
	return chain.reduce(
		(allowed, item) =>
			item.authentication
				? allowed.filter((name) => item.authentication!.schemes.includes(name))
				: allowed,
		authentication.schemes.map((scheme) => scheme.name),
	);
}

/**
 * Whether an operation can answer `ambiguousCredentials`: strict multiple-credential mode, and
 * more than one scheme the operation accepts.
 */
export function rejectsAmbiguousCredentials(
	chain: readonly MiddlewareMetadata[],
	authentication: AuthenticationMetadata | undefined,
): boolean {
	return (
		authentication?.multipleCredentials === "reject"
		&& allowedSchemes(chain, authentication).length > 1
	);
}

/**
 * Reports operations whose `requireAuth` guards each allow schemes, but none in common, so no
 * request could pass them. A guard that allows no configured scheme is reported where it is
 * written.
 */
export function requirementIntersectionDiagnostics(
	routes: ReadonlyArray<{
		file: string;
		path: string;
		methods: readonly string[];
		middleware: readonly MiddlewareMetadata[];
		methodMiddleware: Readonly<Record<string, readonly MiddlewareMetadata[]>>;
	}>,
	authentication: AuthenticationMetadata | undefined,
): Diagnostic[] {
	if (!authentication) {
		return [];
	}

	return routes.flatMap((route) =>
		route.methods.flatMap((method) => {
			const chain = route.methodMiddleware[method.toLowerCase()] ?? route.middleware;
			const guards = chain.flatMap((item) => (item.authentication ? [item.authentication] : []));

			return guards.length > 1
				&& guards.every((guard) => guard.schemes.length > 0)
				&& allowedSchemes(chain, authentication).length === 0
				? [
						{
							code: "ROUTA_AUTH_REQUIREMENT_EMPTY",
							severity: "error" as const,
							message: `requireAuth() guards on ${method} ${route.path} allow no scheme in common, so no request could pass them.`,
							file: route.file,
							routePath: route.path,
							suggestion:
								"Allow at least one scheme in every requireAuth() guard on the operation, or remove a guard.",
						},
					]
				: [];
		}),
	);
}
