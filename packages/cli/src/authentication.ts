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
	kind: "bearer";
	/** The static challenge realm, when the scheme overrides it. */
	realm?: string;
};

/** The application's authentication contract facts, in declaration order. */
export type AuthenticationMetadata = {
	schemes: AuthenticationSchemeMetadata[];
};

/** What a `requireAuth` guard contributes to a middleware chain's metadata. */
export type AuthenticationRequirementMetadata = {
	/** The schemes the guard allows, resolved against the configured ones. */
	schemes: string[];
};

const configFile = "src/routa.ts";
const coreModule = "@routa-ts/core";
/** Scheme names are OpenAPI security scheme keys, so they follow the component key rule. */
const schemeNamePattern = /^[a-zA-Z0-9.\-_]+$/;
/** Printable ASCII without `"` or `\`, as `bearer()` checks at runtime. */
const realmPattern = /^[\x20\x21\x23-\x5b\x5d-\x7e]+$/;

export const authenticationRequiredDescription =
	"Authentication is required: the request presented no credential.";
export const authenticationFailedDescription =
	"Authentication failed: the request presented a credential that is malformed, unsupported, or rejected.";

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
): { authentication?: AuthenticationMetadata; diagnostics: Diagnostic[] } {
	if (!existsSync(join(cwd, configFile))) {
		return { diagnostics: [] };
	}

	const { declaration } = routaConfigMember(cwd, parser, "authentication");

	if (!declaration) {
		return { diagnostics: [] };
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
		return { diagnostics };
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
		return { diagnostics };
	}

	const metadata: AuthenticationSchemeMetadata[] = [];

	for (const property of schemes.object.properties) {
		// hasUnreadableMember already rejected every other member kind.
		const member = property as ts.PropertyAssignment | ts.ShorthandPropertyAssignment;
		const name = propertyName(member.name) as string;

		if (!schemeNamePattern.test(name)) {
			report(
				"ROUTA_AUTH_CONFIG_INVALID",
				`Authentication scheme name "${name}" may use only letters, digits, ".", "-", and "_".`,
				"Rename the scheme. Its name is the OpenAPI security scheme key.",
				schemes.file,
			);
			continue;
		}

		const value = memberNode(schemes.object, name) as ts.Expression;
		const descriptor = bearerDescriptor(cwd, schemes.file, value, parser);

		if (!descriptor) {
			unresolved(
				`Authentication scheme "${name}" in ${configFile} is not a statically readable bearer() call.`,
				schemes.file,
			);
			continue;
		}

		const challenge = bearerChallenge(descriptor.options);

		if ("problem" in challenge) {
			report(
				"ROUTA_AUTH_CHALLENGE_INVALID",
				`Authentication scheme "${name}" ${challenge.problem}`,
				'Write the override as a literal, such as challenge: { realm: "api" }, with printable ASCII and no " or \\.',
				descriptor.file,
			);
			continue;
		}

		const earlier = metadata.find((item) => item.kind === "bearer");

		if (earlier) {
			report(
				"ROUTA_AUTH_TRANSPORT_OVERLAP",
				`Authentication schemes "${earlier.name}" and "${name}" both read the Authorization Bearer credential.`,
				"Declare one Bearer scheme, and verify every token format it accepts in its authenticator.",
				schemes.file,
			);
			continue;
		}

		metadata.push({
			name,
			kind: "bearer",
			...(challenge.realm === undefined ? {} : { realm: challenge.realm }),
		});
	}

	if (schemes.object.properties.length === 0) {
		report(
			"ROUTA_AUTH_CONFIG_INVALID",
			`The authentication config in ${configFile} declares no credential schemes.`,
			"Declare a scheme, such as schemes: { userToken: bearer({ authenticate }) }.",
			schemes.file,
		);
	}

	return diagnostics.length > 0
		? { diagnostics }
		: { authentication: { schemes: metadata }, diagnostics };
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

/** Whether an object has a spread, computed key, method, or accessor that could hide a fact. */
function hasUnreadableMember(object: ts.ObjectLiteralExpression): boolean {
	return object.properties.some(
		(property) =>
			!(ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property))
			|| propertyName(property.name) === undefined,
	);
}

/** The value of a named member, including a shorthand one. */
function memberNode(object: ts.ObjectLiteralExpression, name: string): ts.Node | undefined {
	for (const property of object.properties) {
		if (ts.isPropertyAssignment(property) && propertyName(property.name) === name) {
			return property.initializer;
		}

		if (ts.isShorthandPropertyAssignment(property) && propertyName(property.name) === name) {
			return property.name;
		}
	}
}

/** Follows a scheme value to its `bearer({ ... })` call, through `const` bindings and imports. */
function bearerDescriptor(
	cwd: string,
	file: string,
	expression: ts.Expression,
	parser: ts.SourceFileParser,
): { file: string; options: ts.ObjectLiteralExpression } | undefined {
	const read = (node: ts.Expression) => {
		const call = coreCall(node, "bearer");
		return call && objectLiteral(call.arguments[0]);
	};
	const node = unwrapExpression(expression);

	if (ts.isIdentifier(node)) {
		const bound = boundDeclaration(cwd, file, node.text, parser, read);
		return bound && { file: bound.file, options: bound.contract };
	}

	const options = read(node);
	return options && { file, options };
}

/** Reads a Bearer challenge override: absent, or a literal object with only a literal realm. */
function bearerChallenge(
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
				problem: `declares challenge "${key}". A Bearer challenge override accepts only realm.`,
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
