import { existsSync } from "node:fs";
import { join } from "node:path";
import { propertyName, unwrapExpression } from "./ast.js";
import type { Diagnostic } from "./project.js";
import { routaConfigMember, spreadObject } from "./services.js";
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
 * Routa cannot read is an error, not an omitted header.
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
	const warnings: Diagnostic[] = hidden
		? [
				{
					code: "ROUTA_CORRELATION_SPREAD_UNRESOLVED",
					severity: "warning",
					message: `The createRouta config in ${configFile} has a spread, computed key, or config argument that cannot be statically read, so correlation inside it cannot be read.`,
					file: configFile,
					suggestion:
						"Declare correlation as a visible member of the createRouta object, after any spread, or spread a const object literal. Startup rejects correlation that routa generate could not read.",
				},
			]
		: [];

	if (!declaration) {
		return { diagnostics: [], warnings };
	}

	const fail = (code: string, message: string, suggestion: string, file = declaration.file) => ({
		diagnostics: [{ code, severity: "error" as const, message, file, suggestion }],
		warnings,
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
		return { diagnostics: [], warnings };
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

	return { header: name, diagnostics: [], warnings };
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
