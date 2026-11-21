import { existsSync } from "node:fs";
import { join } from "node:path";
import { propertyName, unwrapExpression } from "./ast.js";
import type { Diagnostic } from "./project.js";
import { type HiddenPart, routaConfigMember, spreadObject } from "./services.js";
import * as ts from "./typescript.js";

const configFile = "src/routa.ts";

/** The response header that carries Routa's generated request identity. */
export const requestIdHeader = "x-request-id";

/** The correlation header `correlation: true` reads and echoes. */
const defaultCorrelationHeader = "x-correlation-id";

/** RFC 9110 `token`, the grammar of header names. */
const headerName = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * Headers a correlation ID cannot use: credential headers, and the headers Routa writes itself,
 * which the echo would replace. Headers that authentication schemes or outcomes declare are
 * checked with those declarations.
 */
const claimedHeaders: ReadonlyMap<string, string> = new Map([
	[requestIdHeader, "carries the request identity Routa generates"],
	["authorization", "is a credential header"],
	["proxy-authorization", "is a credential header"],
	["cookie", "is a credential header"],
	["set-cookie", "is a credential header"],
	["content-type", "is a header Routa owns on every response"],
	["content-length", "is a header Routa owns on every response"],
	["transfer-encoding", "is a header Routa owns on every response"],
	["connection", "is a header Routa owns on every response"],
	["allow", "is a header Routa sets on automatic OPTIONS and 405 responses"],
	["access-control-allow-methods", "is a header Routa sets on automatic OPTIONS responses"],
	["vary", "is a header Routa sets on automatic OPTIONS responses"],
	["deprecation", "is a lifecycle header Routa emits"],
	["sunset", "is a lifecycle header Routa emits"],
	["link", "is a lifecycle header Routa emits"],
	["www-authenticate", "carries Routa's authentication challenges"],
]);

/**
 * The OpenAPI Header Objects for the identity Routa sends on every response: `x-request-id`
 * always, and the correlation header, which carries a value only when the request sent a valid one.
 */
export function identityHeaders(correlationHeader: string | undefined): Record<string, unknown> {
	return {
		[requestIdHeader]: {
			required: true,
			description: "The request identity Routa generated for this request.",
			schema: { type: "string", format: "uuid" },
		},
		...(correlationHeader && {
			[correlationHeader]: {
				description:
					"The caller's correlation ID, echoed when the request sent one valid value in this header.",
				schema: { type: "string", minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9._-]+$" },
			},
		}),
	};
}

const shape =
	'Write correlation: true, false, or { header: "x-correlation-id" } with a string literal header. Generated OpenAPI documents the header, so routa generate reads it without running src/routa.ts.';

/**
 * Reads the `correlation` field of the `createRouta` config in `src/routa.ts` without executing
 * it. Whether correlation is on and which header it reads change the HTTP contract, so a value
 * Routa cannot read is an error, not an omitted header. A spread, config argument, or default
 * export that resolves to an object literal or a `createRouta` call is read in place. Any other
 * spread, computed key, config argument, or default export whose type may hold `correlation`,
 * including a `RoutaConfig`, is an error; one whose type has no such member, such as a spread of
 * `{ host: string; port: number }`, is ignored.
 *
 * @returns The lowercase correlation header when correlation is on, and diagnostics
 */
export function applicationCorrelation(
	cwd: string,
	parser: ts.SourceFileParser,
): { header?: string; diagnostics: Diagnostic[]; warnings: Diagnostic[] } {
	if (!existsSync(join(cwd, configFile))) {
		return { diagnostics: [], warnings: [] };
	}

	const { declaration, hidden } = routaConfigMember(cwd, parser, "correlation");
	const hiding = hidden.find((part) => mayHoldCorrelation(cwd, parser, part));

	if (hiding) {
		return {
			diagnostics: [
				{
					code: "ROUTA_CORRELATION_CONFIG_UNRESOLVED",
					severity: "error",
					message: `The createRouta config in ${configFile} has a spread, computed key, config argument, or default export whose type may hold correlation, so routa generate cannot read the correlation header.`,
					file: hiding.file,
					suggestion:
						"Write correlation as a visible member of the createRouta call in src/routa.ts, after every spread. Spread only object literals and createRouta calls, written in place or bound to a const, or values whose type has no correlation member, such as { host: string; port: number }; a RoutaConfig may hold one. Generated OpenAPI documents the correlation header, so routa generate reads it without running src/routa.ts.",
				},
			],
			warnings: [],
		};
	}

	if (!declaration) {
		return { diagnostics: [], warnings: [] };
	}

	const fail = (code: string, message: string, suggestion: string, file = declaration.file) => ({
		diagnostics: [{ code, severity: "error" as const, message, file, suggestion }],
		warnings: [],
	});
	const header = correlationHeader(cwd, declaration.file, declaration.node, parser);

	if (header === undefined) {
		return fail(
			"ROUTA_CORRELATION_CONFIG_UNRESOLVED",
			`The correlation config in ${configFile} cannot be statically read.`,
			shape,
		);
	}

	if (header === false) {
		return { diagnostics: [], warnings: [] };
	}

	if (!headerName.test(header)) {
		return fail(
			"ROUTA_CORRELATION_HEADER_INVALID",
			`The correlation header ${JSON.stringify(header)} in ${configFile} is not a valid header name.`,
			"Use a header name made of letters, digits, and the characters ! # $ % & ' * + - . ^ _ ` | ~, such as x-correlation-id.",
		);
	}

	const name = header.toLowerCase();
	const claimed = claimedHeaders.get(name);

	if (claimed) {
		return fail(
			"ROUTA_CORRELATION_HEADER_CONFLICT",
			`The correlation header ${JSON.stringify(header)} in ${configFile} names ${name}, which ${claimed}.`,
			"Choose a header of its own for correlation, such as x-correlation-id. A correlation ID is not a credential and never replaces x-request-id.",
		);
	}

	return { header: name, diagnostics: [], warnings: [] };
}

/**
 * Whether a part of the config Routa cannot read may set `correlation` at runtime, by its type:
 * a spread, argument, or default export whose type may have a `correlation` member, or a computed
 * key whose type may be `"correlation"`. The checker resolves the types without running any
 * module; a type it cannot resolve may.
 */
function mayHoldCorrelation(cwd: string, parser: ts.SourceFileParser, part: HiddenPart): boolean {
	return (
		parser.withChecker(join(cwd, part.file), (checker) => {
			const type = checker.getTypeAtLocation(part.node);
			return (
				!type
				|| (part.kind === "key"
					? mayName(checker, type, "correlation", 0)
					: mayHaveMember(checker, type, "correlation", 0))
			);
		}) ?? true
	);
}

/** Types Routa does not look through further, which may hold anything. */
const maxTypeDepth = 8;

/**
 * Whether a value of `type`, spread into an object, may set member `name`: when the type is
 * `any`, `unknown`, or unresolved, declares the member, even optionally, as `RoutaConfig` does,
 * or has a string index signature. A union may when any of its members may. `undefined`, `null`,
 * and `never` add nothing.
 */
function mayHaveMember(checker: ts.Checker, type: ts.Type, name: string, depth: number): boolean {
	if (depth > maxTypeDepth || type.flags & ts.TypeFlags.AnyOrUnknown || type.isErrorType()) {
		return true;
	}

	if (type.flags & (ts.TypeFlags.Nullable | ts.TypeFlags.Void | ts.TypeFlags.Never)) {
		return false;
	}

	if (type.isUnionType()) {
		return (type.getTypes() ?? []).some((member) =>
			mayHaveMember(checker, member, name, depth + 1),
		);
	}

	if (type.flags & ts.TypeFlags.Instantiable) {
		const constraint = checker.getBaseConstraintOfType(type);
		return !constraint || constraint.id === type.id
			? true
			: mayHaveMember(checker, constraint, name, depth + 1);
	}

	const apparent = checker.getApparentType(type) ?? type;
	return (
		checker.getPropertyOfType(apparent, name) !== undefined
		|| checker
			.getIndexInfosOfType(apparent)
			.some((info) => !(info.keyType.flags & (ts.TypeFlags.NumberLike | ts.TypeFlags.ESSymbolLike)))
	);
}

/**
 * Whether a computed key of `type` may be `name`: a string literal type only when it is `name`,
 * and number and symbol types never. Any other string type, such as `string` or a template
 * literal, may.
 */
function mayName(checker: ts.Checker, type: ts.Type, name: string, depth: number): boolean {
	if (depth > maxTypeDepth || type.flags & ts.TypeFlags.AnyOrUnknown || type.isErrorType()) {
		return true;
	}

	if (type.isUnionType()) {
		return (type.getTypes() ?? []).some((member) => mayName(checker, member, name, depth + 1));
	}

	if (type.isStringLiteralType()) {
		return type.value === name;
	}

	if (
		type.flags
		& (ts.TypeFlags.NumberLike
			| ts.TypeFlags.ESSymbolLike
			| ts.TypeFlags.Never
			| ts.TypeFlags.BigIntLike)
	) {
		return false;
	}

	if (type.flags & ts.TypeFlags.Instantiable && !(type.flags & ts.TypeFlags.StringLike)) {
		const constraint = checker.getBaseConstraintOfType(type);
		return !constraint || constraint.id === type.id
			? true
			: mayName(checker, constraint, name, depth + 1);
	}

	return true;
}

/**
 * The header a `correlation` value reads: as written for `{ header: "..." }`, the default for
 * `true`, `false` for a literal `false`, or `undefined` when the value cannot be read.
 */
function correlationHeader(
	cwd: string,
	file: string,
	node: ts.Node,
	parser: ts.SourceFileParser,
): string | false | undefined {
	if (!ts.isExpression(node)) {
		return undefined;
	}

	const value = unwrapExpression(node);

	if (value.kind === ts.SyntaxKind.TrueKeyword) {
		return defaultCorrelationHeader;
	}

	if (value.kind === ts.SyntaxKind.FalseKeyword) {
		return false;
	}

	const object = spreadObject(cwd, file, value, parser, 0)?.object;
	const [member, ...others] = object?.properties ?? [];

	if (
		!member
		|| others.length > 0
		|| !ts.isPropertyAssignment(member)
		|| propertyName(member.name) !== "header"
	) {
		return undefined;
	}

	const header = unwrapExpression(member.initializer);
	return ts.isStringLiteralLike(header) ? header.text : undefined;
}
