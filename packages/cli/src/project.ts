import { existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { reservedAuthContext, reservedContext } from "@routa-ts/contract-rules";
import {
	callName,
	objectLiteral,
	objectProperties,
	objectProperty,
	propertyName,
	propertyValue,
	unwrapExpression,
} from "./ast.js";
import {
	applicationAuthentication,
	type AuthenticationMetadata,
	type AuthenticationRequirementMetadata,
	requirementCompositionDiagnostics,
} from "./authentication.js";
import { type ContractSchemaProjection, projectContractSchemas } from "./contract-schemas.js";
import { parseTypeScriptFile } from "./declarations.js";
import { writeGeneratedState } from "./generate.js";
import { middlewareContract } from "./middleware-contracts.js";
import { operationId, toOpenApiPath } from "./operation-id.js";
import { applicationCorrelation } from "./request-identity.js";
import { discoverRoutes, routesRoot, walk } from "./route-discovery.js";
import {
	applicationServices,
	middlewareRequirement,
	requirementPlacements,
	type RouteServicesMetadata,
	type ServiceContractMetadata,
} from "./services.js";
import * as ts from "./typescript.js";

export type Diagnostic = {
	code: string;
	severity: "error" | "warning";
	message: string;
	file?: string | undefined;
	routePath?: string;
	suggestion?: string;
};

export type RouteMetadata = {
	file: string;
	path: string;
	methods: string[];
	responses: Record<string, number[]>;
	inputs: Record<string, RouteMethodInputMetadata>;
	middleware: MiddlewareMetadata[];
	methodMiddleware: Record<string, MiddlewareMetadata[]>;
	/**
	 * Every folder `middleware.ts` on the route's path, root first, including files with no export
	 * Routa reads. Startup loads each one and refuses a `requireAuth` guard export the chain omits.
	 * Written only when the project configures authentication, the one case a guard can run.
	 */
	middlewareFiles?: string[];
	/** The service contracts the route file declares, when it declares any. */
	services?: RouteServicesMetadata;
	deprecations?: Record<string, RouteDeprecationMetadata | undefined>;
	ctx: string[];
	groups: string[];
	segments: string[];
};

export type RouteMethodInputMetadata = {
	params: boolean;
	query: boolean;
	headers: boolean;
	cookies: boolean;
	body: boolean;
};

export type MiddlewareMetadata = {
	file: string;
	name: string;
	requires: string[];
	/** The requirement interface of middleware declared with `createMiddleware<Requirements>()`. */
	requiresServices?: ServiceContractMetadata;
	provides: string[];
	providesTypes: Record<string, string>;
	rejects: MiddlewareRejectMetadata[];
	security: Array<Record<string, string[]>>;
	permissions: string[];
	/** The schemes a `requireAuth` guard allows; present only on that guard. */
	authentication?: AuthenticationRequirementMetadata;
};

export type MiddlewareRejectMetadata = {
	type: string;
	status: number;
	description?: string;
	schema?: string;
};

export type RouteDeprecationMetadata = {
	replacement?: string;
};

export type ProjectValidationResult = {
	routes: RouteMetadata[];
	diagnostics: Diagnostic[];
	warnings: Diagnostic[];
	schemas: ContractSchemaProjection;
	/** The authentication contract `src/routa.ts` declares, when it declares one. */
	authentication?: AuthenticationMetadata;
	/** The lowercase header `src/routa.ts` reads correlation from, when correlation is on. */
	correlationHeader?: string;
};

/**
 * Validates a Routa project and optionally generates route metadata when validation succeeds.
 *
 * @param cwd - The project root directory
 * @param options - Validation options
 * @param options.write - When `true` (default), write `.routa/routes.gen.ts` and
 *   `.routa/testing.gen.ts` after a clean validation
 * @returns The discovered routes and any validation diagnostics
 */
export function validateProject(
	cwd = process.cwd(),
	options: { write?: boolean } = {},
	parser?: ts.SourceFileParser,
): ProjectValidationResult {
	return parser
		? validateProjectInSession(cwd, options, parser)
		: ts.withSourceFileParsing(cwd, (ownedParser) =>
				validateProjectInSession(cwd, options, ownedParser),
			);
}

function validateProjectInSession(
	cwd: string,
	options: { write?: boolean },
	parser: ts.SourceFileParser,
): ProjectValidationResult {
	const write = options.write ?? true;
	const auth = applicationAuthentication(cwd, parser);
	const { authentication } = auth;
	const correlation = applicationCorrelation(cwd, parser, authentication);
	const correlationHeader = correlation.header;
	const discovery = discoverRoutes(cwd, parser, authentication);
	const routes = discovery.routes;
	const schemas = projectContractSchemas(cwd, routes, parser, {
		lifecycleHeaders: lifecycleHeadersEnabled(cwd, parser),
		...(authentication && { authentication }),
		...(correlationHeader && { correlationHeader }),
	});
	const services = applicationServices(cwd, parser);
	const discovered = [
		...discovery.diagnostics,
		...requirementCompositionDiagnostics(routes, authentication),
	];
	const discoveryWarnings = discovered.filter((item) => item.severity === "warning");
	const diagnostics = [
		...projectStructureDiagnostics(cwd),
		...auth.diagnostics,
		...correlation.diagnostics,
		...discovered.filter((item) => item.severity !== "warning"),
		...services.diagnostics,
		...runResultShapeDiagnostics(cwd, parser),
		...duplicateRouteDiagnostics(routes),
		...duplicateOperationIdDiagnostics(routes),
		...deprecationReplacementDiagnostics(routes),
		...missingSuccessResponseDiagnostics(routes),
		...duplicateSchemaDiagnostics(cwd, parser),
		...middlewareOrderDiagnostics(routes, authentication !== undefined),
		...middlewareContextDiagnostics(routes, authentication !== undefined),
		...middlewareRejectStatusDiagnostics(routes),
		...serviceCollisionDiagnostics(routes, services.services),
		...serviceRequirementDiagnostics(routes, services.services),
		...schemas.diagnostics,
	];

	if (write && diagnostics.length === 0) {
		writeGeneratedState(cwd, routes, services.services, authentication, correlationHeader);
	}

	return {
		routes,
		diagnostics,
		warnings: [
			...auth.warnings,
			...correlation.warnings,
			...services.warnings,
			...discoveryWarnings,
			...schemas.warnings,
		],
		schemas,
		...(authentication && { authentication }),
		...(correlationHeader && { correlationHeader }),
	};
}

/**
 * Reads whether `src/routa.ts` may turn lifecycle headers on.
 *
 * Lifecycle headers are a tuning-backed feature: a literal `false` or an omitted key keeps them
 * off, and any other value counts as possibly enabled. A configuration the source cannot be read
 * for the key, such as a variable, a call, a spread, or a computed key, counts the same way.
 * Generation never executes application modules, so ownership diagnostics apply to every
 * configuration the source can produce.
 */
function lifecycleHeadersEnabled(cwd: string, parser: ts.SourceFileParser): boolean {
	const file = join(cwd, "src/routa.ts");

	if (!existsSync(file)) {
		return false;
	}

	const sourceFile = parseTypeScriptFile(file, parser);
	let foundCall = false;
	let enabled = false;
	const visit = (node: ts.Node): void => {
		if (ts.isCallExpression(node) && callName(node.expression) === "createRouta") {
			foundCall = true;
			enabled ||= configMayEnableLifecycleHeaders(node.arguments[0]);
		}

		ts.forEachChild(node, visit);
	};

	visit(sourceFile);
	const hasDefaultExport = sourceFile.statements.some(
		(statement) =>
			(ts.isExportAssignment(statement) && !statement.isExportEquals)
			|| (ts.isExportDeclaration(statement)
				&& statement.exportClause
				&& ts.isNamedExports(statement.exportClause)
				&& statement.exportClause.elements.some((element) => element.name.text === "default")),
	);
	return enabled || (!foundCall && hasDefaultExport);
}

/** Walks a config in source order, so a later literal `false` overrides what a spread may hold. */
function configMayEnableLifecycleHeaders(argument: ts.Expression | undefined): boolean {
	if (!argument) {
		return false;
	}

	const config = objectLiteral(argument);

	if (!config) {
		return true;
	}

	let enabled = false;

	for (const member of config.properties) {
		if (ts.isSpreadAssignment(member) || ts.isComputedPropertyName(member.name)) {
			enabled = true;
		} else if (propertyName(member.name) === "lifecycleHeaders") {
			enabled =
				!ts.isPropertyAssignment(member)
				|| unwrapExpression(member.initializer).kind !== ts.SyntaxKind.FalseKeyword;
		}
	}

	return enabled;
}

/**
 * Reports route methods that do not declare a 2xx success response.
 *
 * DELETE methods are included and may satisfy the check with a 204 response.
 *
 * @param routes - Route metadata to inspect
 * @returns Diagnostics for route methods missing a declared 2xx response
 */
function missingSuccessResponseDiagnostics(routes: RouteMetadata[]): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];

	for (const route of routes) {
		for (const [method, statuses] of Object.entries(route.responses)) {
			if (!statuses.some((status) => status >= 200 && status < 300)) {
				diagnostics.push({
					code: "ROUTA_MISSING_SUCCESS_RESPONSE",
					severity: "error",
					message: `${method.toUpperCase()} ${route.path} is missing a 2xx success response.`,
					file: route.file,
					routePath: route.path,
					suggestion:
						method === "delete"
							? "Add a declared success response with a 2xx HTTP status (204 is allowed)."
							: "Add a declared success response with a 2xx HTTP status.",
				});
			}
		}
	}

	return diagnostics;
}

/**
 * Reports duplicate schema export names in route schema files.
 *
 * @param cwd - Project root directory
 * @returns Diagnostics for repeated `export const` names in route `schemas.ts` files under `src/routes`
 */
function duplicateSchemaDiagnostics(cwd: string, parser: ts.SourceFileParser): Diagnostic[] {
	const routesDir = join(cwd, routesRoot);

	if (!existsSync(routesDir)) {
		return [];
	}

	const diagnostics: Diagnostic[] = [];

	for (const file of walk(routesDir).filter((item) => item.endsWith(`${sep}schemas.ts`))) {
		const relativeFile = relative(cwd, file);
		const sourceFile = parseTypeScriptFile(file, parser);
		const seen = new Set<string>();

		for (const statement of sourceFile.statements) {
			if (!ts.isVariableStatement(statement)) {
				continue;
			}

			if (!statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
				continue;
			}

			if (!(statement.declarationList.flags & ts.NodeFlags.Const)) {
				continue;
			}

			for (const declaration of statement.declarationList.declarations) {
				if (!ts.isIdentifier(declaration.name)) {
					continue;
				}

				const name = declaration.name.text;

				if (seen.has(name)) {
					diagnostics.push({
						code: "ROUTA_DUPLICATE_SCHEMA_NAME",
						severity: "error",
						message: `Duplicate schema export ${name}.`,
						file: relativeFile,
						suggestion: "Use a stable contract-purpose name such as CreateUserResponse.",
					});
					continue;
				}

				seen.add(name);
			}
		}
	}

	return diagnostics;
}

function runResultShapeDiagnostics(cwd: string, parser: ts.SourceFileParser): Diagnostic[] {
	const srcDir = join(cwd, "src");

	if (!existsSync(srcDir)) {
		return [];
	}

	return walk(srcDir)
		.filter((file) => file.endsWith(".ts"))
		.flatMap((file) => runResultShapeDiagnosticsForFile(cwd, relative(cwd, file), file, parser));
}

function runResultShapeDiagnosticsForFile(
	cwd: string,
	relativeFile: string,
	file: string,
	parser: ts.SourceFileParser,
): Diagnostic[] {
	const sourceFile = parseTypeScriptFile(file, parser);
	const diagnostics: Diagnostic[] = [];

	// Middleware declared through a helper bound to `createMiddleware<Requirements>()` is checked
	// like a direct `createMiddleware` call.
	function contractKind(call: ts.CallExpression): "route" | "middleware" | undefined {
		const name = callName(call.expression);

		if (name === "createRoute") {
			return "route";
		}

		return name === "createMiddleware"
			|| (ts.isIdentifier(unwrapExpression(call.expression))
				&& middlewareRequirement(cwd, relativeFile, call.expression, parser) !== undefined)
			? "middleware"
			: undefined;
	}

	function visit(node: ts.Node): void {
		const kind =
			ts.isCallExpression(node)
			&& node.arguments[0] !== undefined
			&& ts.isObjectLiteralExpression(node.arguments[0])
				? contractKind(node)
				: undefined;

		if (kind && ts.isCallExpression(node) && node.arguments[0] !== undefined) {
			const contract = node.arguments[0] as ts.ObjectLiteralExpression;
			const run = objectProperty(contract, "run");
			const resultTypes =
				kind === "route"
					? contractObjectKeys(contract, "responses")
					: contractObjectKeys(contract, "rejects");

			if (run) {
				diagnostics.push(
					...runReturnObjectDiagnostics(
						cwd,
						sourceFile,
						relativeFile,
						run.initializer,
						resultTypes,
					),
				);
			}
		}

		ts.forEachChild(node, visit);
	}

	visit(sourceFile);
	return diagnostics;
}

function runReturnObjectDiagnostics(
	cwd: string,
	sourceFile: ts.SourceFile,
	file: string,
	run: ts.Expression,
	resultTypes: Set<string> | undefined,
): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];

	function checkReturn(expression: ts.Expression): void {
		const object = objectLiteral(expression);

		if (!object) {
			return;
		}

		for (const property of objectProperties(object)) {
			const name = propertyName(property.name);

			if (!name || name === "type" || name === "data" || name === "headers" || name === "cookies") {
				continue;
			}

			const position = sourceFile.getLineAndCharacterOfPosition(property.name.getStart(sourceFile));
			diagnostics.push({
				code: "ROUTA_RESULT_SHAPE",
				severity: "error",
				message: `Run result includes unsupported field "${name}". Route and middleware results may only include "type", "data", "headers", and "cookies".`,
				file: `${file}:${position.line + 1}:${position.character + 1}`,
				suggestion: `Remove "${name}" from the returned result object.`,
			});
		}

		const typeProperty = objectProperty(object, "type");
		const typeExpression = typeProperty ? unwrapExpression(typeProperty.initializer) : undefined;

		if (
			resultTypes
			&& typeProperty
			&& typeExpression
			&& ts.isStringLiteralLike(typeExpression)
			&& !resultTypes.has(typeExpression.text)
		) {
			const position = sourceFile.getLineAndCharacterOfPosition(
				typeProperty.initializer.getStart(sourceFile),
			);
			const options = [...resultTypes].map((type) => `"${type}"`).join(", ");
			diagnostics.push({
				code: "ROUTA_RESULT_TYPE",
				severity: "error",
				message: `Run result type "${typeExpression.text}" is not declared.`,
				file: `${file}:${position.line + 1}:${position.character + 1}`,
				suggestion: options
					? `Use one of the declared result types: ${options}.`
					: "Declare this result type before returning it.",
			});
		}
	}

	function visit(node: ts.Node): void {
		if (ts.isReturnStatement(node) && node.expression) {
			checkReturn(node.expression);
		}

		if (
			(ts.isArrowFunction(run) || ts.isFunctionExpression(run))
			&& run.body === node
			&& ts.isExpression(node)
		) {
			checkReturn(node);
		}

		ts.forEachChild(node, visit);
	}

	if (ts.isArrowFunction(run) || ts.isFunctionExpression(run)) {
		visit(run.body);
	}

	return diagnostics.map((diagnostic) => ({
		...diagnostic,
		file: diagnostic.file?.startsWith(cwd) ? relative(cwd, diagnostic.file) : diagnostic.file,
	}));
}

function contractObjectKeys(
	contract: ts.ObjectLiteralExpression,
	name: string,
): Set<string> | undefined {
	const property = objectProperty(contract, name);
	const object = objectLiteral(property?.initializer);

	if (!object) {
		return;
	}

	return new Set(
		objectProperties(object).flatMap((item) => {
			const key = propertyName(item.name);
			return key ? [key] : [];
		}),
	);
}

/**
 * Verifies that the required Routa project files and directories exist.
 *
 * @returns Diagnostics for each missing required project item.
 */
function projectStructureDiagnostics(cwd: string): Diagnostic[] {
	const required = [
		{ path: "package.json", message: "Missing package.json." },
		{ path: "tsconfig.json", message: "Missing tsconfig.json." },
		{ path: "src", message: "Missing src/ directory." },
		{ path: "src/routa.ts", message: "Missing src/routa.ts." },
	];

	return required
		.filter((item) => !existsSync(join(cwd, item.path)))
		.map((item) => ({
			code: "ROUTA_PROJECT_REQUIRED",
			severity: "error" as const,
			message: `${item.message} Routa commands must run inside a TypeScript Routa project.`,
			file: item.path,
			suggestion:
				"Create a project with pnpm create routa-ts@latest, or run this command at the project root.",
		}));
}

/**
 * Validates middleware ordering for each route.
 *
 * @returns Diagnostics for middleware that requires context before it has been provided.
 */
function middlewareOrderDiagnostics(routes: RouteMetadata[], authenticated: boolean): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];

	for (const route of routes) {
		const chains =
			route.methods.length > 0
				? route.methods.map(
						(item) => route.methodMiddleware[item.toLowerCase()] ?? route.middleware,
					)
				: [route.middleware];

		for (const chain of chains) {
			// Credential orchestration resolves ctx.auth before the first middleware runs, and Routa
			// gives every middleware the request identity and logger.
			const provided = new Set<string>([
				...(authenticated ? ["auth"] : []),
				"requestId",
				"correlationId",
				"logger",
			]);

			for (const middleware of chain) {
				for (const required of middleware.requires) {
					if (!provided.has(required)) {
						diagnostics.push({
							code: "ROUTA_MIDDLEWARE_ORDER",
							severity: "error",
							message: `${middleware.name} requires ctx.${required} before it is provided.`,
							file: middleware.file,
							routePath: route.path,
							suggestion: `Move middleware that provides ${required} before ${middleware.name}.`,
						});
					}
				}

				for (const providedField of middleware.provides) {
					provided.add(providedField);
				}
			}
		}
	}

	return diagnostics;
}

/**
 * Reports middleware context Routa cannot accept: `ctx.services`, `ctx.requestId`,
 * `ctx.correlationId`, and `ctx.logger`, which it reserves, whether provided or passed to
 * `next()`, `provides` it cannot read from source, and a requirement interface it cannot read.
 *
 * @param routes - Route metadata whose middleware chains are checked, each contract once
 */
function middlewareContextDiagnostics(
	routes: RouteMetadata[],
	authenticated: boolean,
): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	const seen = new Set<ts.ObjectLiteralExpression>();
	const provided = { ...reservedContext, ...(authenticated && { auth: reservedAuthContext }) };

	for (const route of routes) {
		for (const item of [route.middleware, ...Object.values(route.methodMiddleware)].flat()) {
			const source = middlewareContract(item);

			if (!source || seen.has(source.contract)) {
				continue;
			}

			seen.add(source.contract);
			diagnostics.push(...source.requirementDiagnostics);
			const report = (code: string, message: string, suggestion: string) =>
				diagnostics.push({ code, severity: "error", message, file: source.file, suggestion });
			const passed = nextPayloadKeys(source.contract);

			if (source.providesUnresolved) {
				report(
					"ROUTA_MIDDLEWARE_PROVIDES_UNRESOLVED",
					`Middleware ${item.name} declares provides that cannot be statically read.`,
					"Declare provides as an object literal, or a const object literal it names, with a plain key for each schema and no spreads.",
				);
			}

			for (const [key, { reason, advice }] of Object.entries(provided)) {
				if (item.provides.includes(key)) {
					report(
						"ROUTA_CONTEXT_RESERVED",
						`Middleware ${item.name} provides ctx.${key}, which Routa reserves for ${reason}.`,
						advice,
					);
				}
			}

			for (const [key, { reason, advice }] of Object.entries(reservedContext)) {
				if (passed.includes(key)) {
					report(
						"ROUTA_CONTEXT_RESERVED",
						`Middleware ${item.name} passes ctx.${key} to next(), which Routa reserves for ${reason}.`,
						advice,
					);
				}
			}
		}
	}

	return diagnostics;
}

/**
 * The keys of every object a middleware's `run` passes to its own `next` continuation: an object
 * literal written in the call, or a `const` object literal the call names. A call to a nested
 * function that rebinds the continuation's name is not the continuation.
 */
function nextPayloadKeys(contract: ts.ObjectLiteralExpression): string[] {
	const run = runFunction(contract);
	const parameter = run?.parameters[0]?.name;
	const continuation = parameter && continuationName(parameter);

	if (!run || !continuation) {
		return [];
	}

	const keys: string[] = [];
	const visit = (node: ts.Node): void => {
		if (node !== run && isFunctionNode(node) && rebinds(node, continuation)) {
			return;
		}

		// A block that declares its own binding of the name calls that binding, not the continuation.
		if (
			ts.isBlock(node)
			&& node.parent !== run
			&& "binding" in continuation
			&& blockDeclares(node, continuation.binding)
		) {
			return;
		}

		if (ts.isCallExpression(node) && callsContinuation(node.expression, continuation)) {
			keys.push(...payloadKeys(run, payloadObject(run, node.arguments[0]), 0));
		}

		ts.forEachChild(node, visit);
	};

	visit(run);
	return keys;
}

/** Whether a block's own statements declare `name`, as a variable, function, or class. */
function blockDeclares(block: ts.Block, name: string): boolean {
	return block.statements.some((statement) =>
		ts.isVariableStatement(statement)
			? statement.declarationList.declarations.some((declaration) =>
					bindsName(declaration.name, name),
				)
			: (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement))
				&& statement.name?.text === name,
	);
}

/** The keys an object payload names, including those of spreads `payloadObject` can read. */
function payloadKeys(
	run: RunFunction,
	payload: ts.ObjectLiteralExpression | undefined,
	depth: number,
): string[] {
	if (!payload || depth > 8) {
		return [];
	}

	return payload.properties.flatMap((property) => {
		if (ts.isSpreadAssignment(property)) {
			return payloadKeys(run, payloadObject(run, property.expression), depth + 1);
		}

		const name =
			ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)
				? propertyName(property.name)
				: undefined;

		return name === undefined ? [] : [name];
	});
}

type RunFunction = ts.ArrowFunction | ts.FunctionExpression | ts.MethodDeclaration;

/** The middleware's `run`, written as a property or as a method. */
function runFunction(contract: ts.ObjectLiteralExpression): RunFunction | undefined {
	const method = contract.properties.find(
		(property): property is ts.MethodDeclaration =>
			ts.isMethodDeclaration(property) && propertyName(property.name) === "run",
	);
	const value = method ?? propertyValue(contract, "run");
	const run = value && ts.isExpression(value) ? unwrapExpression(value) : value;

	return run
		&& (ts.isArrowFunction(run) || ts.isFunctionExpression(run) || ts.isMethodDeclaration(run))
		? run
		: undefined;
}

/**
 * How `run` reaches its continuation: the local name `{ next }` destructures it to, or the
 * parameter whose `next` member it calls.
 */
function continuationName(
	parameter: ts.BindingName,
): { binding: string } | { member: string } | undefined {
	if (ts.isIdentifier(parameter)) {
		return { member: parameter.text };
	}

	if (!ts.isObjectBindingPattern(parameter)) {
		return;
	}

	for (const element of parameter.elements) {
		const key = element.propertyName ? propertyName(element.propertyName) : undefined;

		const local = element.name && ts.isIdentifier(element.name) ? element.name.text : undefined;

		if ((key ?? local) === "next") {
			return local === undefined ? undefined : { binding: local };
		}
	}
}

function callsContinuation(
	callee: ts.Expression,
	continuation: { binding: string } | { member: string },
): boolean {
	if ("binding" in continuation) {
		return ts.isIdentifier(callee) && callee.text === continuation.binding;
	}

	return (
		ts.isPropertyAccessExpression(callee)
		&& ts.isIdentifier(callee.expression)
		&& callee.expression.text === continuation.member
		&& ts.isIdentifier(callee.name)
		&& callee.name.text === "next"
	);
}

type FunctionNode =
	| ts.ArrowFunction
	| ts.FunctionExpression
	| ts.FunctionDeclaration
	| ts.MethodDeclaration;

function isFunctionNode(node: ts.Node): node is FunctionNode {
	return (
		ts.isArrowFunction(node)
		|| ts.isFunctionExpression(node)
		|| ts.isFunctionDeclaration(node)
		|| ts.isMethodDeclaration(node)
	);
}

/** Whether a nested function's own name or parameters shadow the continuation's name. */
function rebinds(
	fn: FunctionNode,
	continuation: { binding: string } | { member: string },
): boolean {
	const name = "binding" in continuation ? continuation.binding : continuation.member;
	const bound = (binding: ts.BindingName): boolean =>
		ts.isIdentifier(binding)
			? binding.text === name
			: binding.elements.some(
					(element) => "name" in element && element.name !== undefined && bound(element.name),
				);

	return (
		(!ts.isArrowFunction(fn)
			&& fn.name !== undefined
			&& ts.isIdentifier(fn.name)
			&& fn.name.text === name)
		|| fn.parameters.some((item) => bound(item.name))
	);
}

/** The object a continuation call passes, written in the call or named by a `const` in `run`. */
function payloadObject(
	run: RunFunction,
	argument: ts.Expression | undefined,
): ts.ObjectLiteralExpression | undefined {
	const written = objectLiteral(argument);

	if (written || !argument) {
		return written;
	}

	const payload = unwrapExpression(argument);

	if (!ts.isIdentifier(payload)) {
		return;
	}

	// The `const` the call can see: the one declared in the nearest enclosing block within `run`,
	// so a same-named `const` in another block never stands in for the payload.
	for (let scope: ts.Node | undefined = payload.parent; scope; scope = scope.parent) {
		// A function between the call and `run` that binds the name as a parameter shadows any
		// outer `const`; what that parameter holds is not statically known.
		if (
			scope !== run
			&& (ts.isArrowFunction(scope)
				|| ts.isFunctionExpression(scope)
				|| ts.isFunctionDeclaration(scope)
				|| ts.isMethodDeclaration(scope))
			&& scope.parameters.some((parameter) => bindsName(parameter.name, payload.text))
		) {
			return;
		}

		// A loop or catch binding between the call and `run` also shadows an outer `const`.
		if (
			(ts.isForOfStatement(scope) || ts.isForInStatement(scope) || ts.isForStatement(scope))
			&& scope.initializer
			&& ts.isVariableDeclarationList(scope.initializer)
			&& scope.initializer.declarations.some((declaration) =>
				bindsName(declaration.name, payload.text),
			)
		) {
			return;
		}

		if (
			ts.isCatchClause(scope)
			&& scope.variableDeclaration
			&& bindsName(scope.variableDeclaration.name, payload.text)
		) {
			return;
		}

		if (ts.isBlock(scope)) {
			for (const statement of scope.statements) {
				if (ts.isVariableStatement(statement)) {
					const isConst = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;

					for (const declaration of statement.declarationList.declarations) {
						if (bindsName(declaration.name, payload.text)) {
							// Only a `const` object literal is known; a `let` or `var` may hold anything.
							return isConst && ts.isIdentifier(declaration.name)
								? objectLiteral(declaration.initializer)
								: undefined;
						}
					}
				}
			}
		}

		if (scope === run) {
			return;
		}
	}

	return;
}

/** Whether a parameter's binding, destructured or not, declares `name`. */
function bindsName(binding: ts.BindingName, name: string): boolean {
	if (ts.isIdentifier(binding)) {
		return binding.text === name;
	}

	return binding.elements.some(
		(element) =>
			ts.isBindingElement(element) && element.name !== undefined && bindsName(element.name, name),
	);
}

function middlewareRejectStatusDiagnostics(routes: RouteMetadata[]): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];

	for (const route of routes) {
		for (const middleware of [
			...route.middleware,
			...Object.values(route.methodMiddleware).flat(),
		]) {
			for (const reject of middleware.rejects) {
				if (reject.status >= 400 && reject.status <= 599) {
					continue;
				}

				diagnostics.push({
					code: "ROUTA_MIDDLEWARE_REJECT_STATUS",
					severity: "error",
					message: `${middleware.name} reject "${reject.type}" uses non-error status ${reject.status}.`,
					file: middleware.file,
					routePath: route.path,
					suggestion: "Middleware rejects must use a 4xx or 5xx HTTP status.",
				});
			}
		}
	}

	return diagnostics;
}

/**
 * Reports routes that share the same path.
 *
 * @param routes - The discovered route metadata to inspect.
 * @returns Diagnostics for each duplicate route path.
 */
/**
 * Reports a service name that more than one scope combined for a request declares: the
 * application, the route file, and one method. Unrelated route files and methods may reuse names.
 */
function serviceCollisionDiagnostics(
	routes: RouteMetadata[],
	application: ServiceContractMetadata | undefined,
): Diagnostic[] {
	type Scope = { owner: string; contract: ServiceContractMetadata };
	const diagnostics: Diagnostic[] = [];

	for (const route of routes) {
		const { routeFile, methods = {} } = route.services ?? {};
		const applicationScope: Scope[] = application
			? [{ owner: "the application services in src/routa.ts", contract: application }]
			: [];
		const routeFileScope: Scope[] = routeFile
			? [{ owner: "the route file's services", contract: routeFile }]
			: [];
		const scopes = [
			...routeFileScope.map((scope) => ({ ...scope, earlier: applicationScope })),
			...Object.entries(methods).map(([method, contract]) => ({
				owner: `the ${method.toUpperCase()} services`,
				contract,
				earlier: [...applicationScope, ...routeFileScope],
			})),
		];

		for (const { owner, contract, earlier } of scopes) {
			for (const name of contract.names) {
				const first = earlier.find((scope) => scope.contract.names.includes(name));

				if (first) {
					diagnostics.push({
						code: "ROUTA_SERVICES_DUPLICATE",
						severity: "error",
						message: `Service "${name}" is declared by ${first.owner} and by ${owner}, which run in one request.`,
						file: route.file,
						routePath: route.path,
						suggestion:
							"Rename one of the services. Services combined for one request need distinct names; unrelated route files and methods may reuse a name.",
					});
				}
			}
		}
	}

	return diagnostics;
}

/**
 * Reports middleware that requires a service its placement does not provide. Filesystem
 * middleware sees application services, route-file middleware also its route file's, and method
 * middleware also its method's. A name only a later factory builds is still unavailable.
 */
function serviceRequirementDiagnostics(
	routes: RouteMetadata[],
	application: ServiceContractMetadata | undefined,
): Diagnostic[] {
	const fixes = {
		filesystem: (name: string) =>
			`Filesystem middleware sees only application services. Declare ${name} in the application services, or move the middleware into a route file or method that declares it.`,
		"route-file": (name: string) =>
			`Route-file middleware sees application and route-file services. Declare ${name} in one of them, or move the middleware into a method that declares it.`,
		method: (name: string) =>
			`Method middleware sees application, route-file, and method services. Declare ${name} in one of them.`,
	};
	const diagnostics: Diagnostic[] = [];

	for (const route of routes) {
		for (const placement of requirementPlacements(route)) {
			const { middleware } = placement;
			const available = new Set(
				[application, ...placement.scopes].flatMap((scope) => scope?.names ?? []),
			);

			for (const name of middleware.requiresServices.names) {
				if (available.has(name)) {
					continue;
				}

				const later = placement.later.find((scope) => scope.contract.names.includes(name));
				diagnostics.push({
					code: "ROUTA_SERVICES_UNAVAILABLE",
					severity: "error",
					message: `${placement.kind} middleware ${middleware.name} requires service ${JSON.stringify(name)}, which ${placement.where} does not provide before it runs.${
						later ? ` ${later.owner} declare it, but their factory runs after this middleware.` : ""
					}`,
					file: middleware.file,
					routePath: route.path,
					suggestion: fixes[placement.position](JSON.stringify(name)),
				});
			}
		}
	}

	return diagnostics;
}

function duplicateRouteDiagnostics(routes: RouteMetadata[]): Diagnostic[] {
	const seen = new Map<string, RouteMetadata>();
	const diagnostics: Diagnostic[] = [];

	for (const route of routes) {
		const previous = seen.get(route.path);

		if (previous) {
			diagnostics.push({
				code: "ROUTA_DUPLICATE_ROUTE",
				severity: "error",
				message: `Duplicate route path ${route.path}.`,
				file: route.file,
				routePath: route.path,
				suggestion: `Rename or move ${route.file}; it conflicts with ${previous.file}.`,
			});
			continue;
		}

		seen.set(route.path, route);
	}

	return diagnostics;
}

/**
 * Reports routes whose generated OpenAPI operationIds collide.
 *
 * The id comes from the method and path, and paths such as `/users/:id` and
 * `/users/id` spell the same words, so they can still produce one id.
 */
function duplicateOperationIdDiagnostics(routes: RouteMetadata[]): Diagnostic[] {
	const seen = new Map<string, string>();
	const diagnostics: Diagnostic[] = [];

	for (const route of routes) {
		for (const method of Object.keys(route.responses)) {
			const id = operationId(method, toOpenApiPath(route.path));
			const previous = seen.get(id);

			if (!previous) {
				seen.set(id, `${method.toUpperCase()} ${route.path}`);
				continue;
			}

			diagnostics.push({
				code: "ROUTA_DUPLICATE_OPERATION_ID",
				severity: "error",
				message: `${method.toUpperCase()} ${route.path} and ${previous} would both generate the OpenAPI operationId ${id}.`,
				file: route.file,
				routePath: route.path,
				suggestion:
					"Rename a path segment so the two routes differ by more than punctuation or parameter syntax. Routa generates operationIds from the method and path.",
			});
		}
	}

	return diagnostics;
}

function deprecationReplacementDiagnostics(routes: RouteMetadata[]): Diagnostic[] {
	const paths = new Set(routes.map((route) => route.path));
	const diagnostics: Diagnostic[] = [];

	for (const route of routes) {
		for (const [method, deprecation] of Object.entries(route.deprecations ?? {})) {
			if (!deprecation) continue;
			const replacement = deprecation.replacement;
			if (!replacement) continue;

			if (replacement.startsWith("/")) {
				if (!paths.has(replacement)) {
					diagnostics.push({
						code: "ROUTA_DEPRECATION_REPLACEMENT_ROUTE_NOT_FOUND",
						severity: "error",
						message: `${method.toUpperCase()} ${route.path} deprecation replacement ${replacement} is not a Routa route.`,
						file: route.file,
						routePath: route.path,
						suggestion:
							"Use an existing local path beginning with /, or an absolute http(s) URL for another API.",
					});
				}
				continue;
			}

			if (!isExternalApiUrl(replacement)) {
				diagnostics.push({
					code: "ROUTA_DEPRECATION_REPLACEMENT_URL_INVALID",
					severity: "error",
					message: `${method.toUpperCase()} ${route.path} deprecation replacement must be an existing local path or absolute http(s) URL.`,
					file: route.file,
					routePath: route.path,
					suggestion:
						"Use /new-route for this API, or https://api.example.com/new-route for another API.",
				});
			}
		}
	}

	return diagnostics;
}

function isExternalApiUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

/**
 * Formats diagnostics into a newline-separated report.
 *
 * @param diagnostics - Diagnostics to format
 * @returns The formatted diagnostic report
 */
export function formatDiagnostics(diagnostics: Diagnostic[]): string {
	return diagnostics
		.map((diagnostic) => {
			const severity = diagnostic.severity === "warning" ? "Warning: " : "";
			const location = diagnostic.file ? `${diagnostic.file}: ` : "";
			const suggestion = diagnostic.suggestion ? `\nSuggestion: ${diagnostic.suggestion}` : "";
			return `${severity}${diagnostic.code}: ${location}${diagnostic.message}${suggestion}`;
		})
		.join("\n");
}
