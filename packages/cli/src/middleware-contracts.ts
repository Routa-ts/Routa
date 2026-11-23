import { join } from "node:path";
import {
	callName,
	coreCall,
	createRouteObject,
	objectLiteral,
	objectProperties,
	objectProperty,
	propertyName,
	propertyValue,
	routeConfigObject,
	unwrapExpression,
} from "./ast.js";
import {
	type AuthenticationMetadata,
	folderGuard,
	requireAuthMiddleware,
} from "./authentication.js";
import {
	boundDeclaration,
	type DeclarationReader,
	exportedDeclaration,
	moduleExports,
	namedImportMap,
	parseTypeScriptFile,
	variableDeclarations,
} from "./declarations.js";
import type { Diagnostic, MiddlewareMetadata, MiddlewareRejectMetadata } from "./project.js";
import { httpMethods, numericValue } from "./route-contracts.js";
import { middlewareRequirement, requirementContract } from "./services.js";
import * as ts from "./typescript.js";
import { typeForExpression, zodObjectShape, zodType } from "./zod-types.js";

/** A folder `middleware.ts` file's middleware, in export order, and what Routa reports about it. */
export type FolderMiddleware = { middleware: MiddlewareMetadata[]; diagnostics: Diagnostic[] };

/**
 * Parses exported middleware declarations from a middleware file: `createMiddleware` contracts
 * and `requireAuth` guards, in export order.
 *
 * Each entry names the middleware file and the name it exports, which the runtime can import
 * even when the declaration is private to another module or exported under an alias.
 *
 * @param cwd - Project root used to resolve `file`.
 * @param file - Path to the middleware file relative to `cwd`.
 * @returns Metadata for each exported middleware declaration found in the file, and diagnostics
 *   for guards it cannot use.
 */
export function parseMiddlewareFile(
	cwd: string,
	file: string,
	parser: ts.SourceFileParser,
	authentication: AuthenticationMetadata | undefined,
): FolderMiddleware {
	const sourceFile = parseTypeScriptFile(join(cwd, file), parser);
	const read = middlewareReader(cwd, parser);
	const middleware: MiddlewareMetadata[] = [];
	const diagnostics: Diagnostic[] = [];

	const readsMiddleware = (expression: ts.Expression, from: string) =>
		read(expression, from) !== undefined;

	for (const exported of moduleExports(cwd, file, sourceFile, parser)) {
		// The core requireAuth is a guard even when imported under the name createMiddleware.
		const declaration =
			exported.value && ts.isExpression(exported.value) && !coreCall(exported.value, "requireAuth")
				? read(exported.value, exported.file)
				: undefined;

		if (declaration) {
			middleware.push(
				middlewareMetadata(cwd, parser, file, exported.exportedName, declaration, exported.file),
			);
			continue;
		}

		const guard = folderGuard(cwd, file, exported, parser, authentication, readsMiddleware);
		middleware.push(...(guard.metadata ? [guard.metadata] : []));
		diagnostics.push(...guard.diagnostics);
	}

	return { middleware, diagnostics };
}

/**
 * The `createMiddleware({ ... })` argument behind each discovered middleware and the file that
 * declares it. Route files record middleware they import under their own path, and middleware
 * files record the names they export, so `file` on the metadata is not always where the contract
 * lives. Kept beside the metadata so it never reaches generated files.
 */
const middlewareContracts = new WeakMap<MiddlewareMetadata, MiddlewareSource>();

/** Where a discovered middleware's contract lives, and what Routa could not read from it. */
type MiddlewareSource = {
	file: string;
	contract: ts.ObjectLiteralExpression;
	providesUnresolved: boolean;
	/** Why its requirement interface cannot be read, when it has one. */
	requirementDiagnostics: Diagnostic[];
};

/**
 * Finds the contract a discovered middleware was read from, so its rejects can be checked like
 * route outcomes.
 *
 * @param middleware - Middleware metadata from route discovery
 * @returns The declaring file and `createMiddleware` argument, or `undefined` for other metadata
 */
export function middlewareContract(middleware: MiddlewareMetadata): MiddlewareSource | undefined {
	return middlewareContracts.get(middleware);
}

/**
 * Extracts middleware metadata declared in a route file.
 *
 * @param cwd - The project root directory.
 * @param routeFile - The route file path relative to `cwd`.
 * @returns The route-level middleware list and per-method middleware lists.
 */
export function parseRouteFileMiddleware(
	cwd: string,
	routeFile: string,
	parser: ts.SourceFileParser,
	authentication: AuthenticationMetadata | undefined,
): {
	route: MiddlewareMetadata[];
	methods: Record<string, MiddlewareMetadata[]>;
	unresolved: string[];
	diagnostics: Diagnostic[];
} {
	const sourceFile = parseTypeScriptFile(join(cwd, routeFile), parser);
	const routeConfig = routeConfigObject(sourceFile);
	const diagnostics: Diagnostic[] = [];

	if (!routeConfig) {
		return { route: [], methods: {}, unresolved: [], diagnostics };
	}

	const read = middlewareReader(cwd, parser);
	const middleware = variableDeclarations(routeFile, sourceFile, false, read);
	const middlewareByName = new Map(middleware.map((item) => [item.name, item.contract]));
	const imports = namedImportMap(cwd, routeFile, sourceFile);
	const route: MiddlewareMetadata[] = [];
	const methods: Record<string, MiddlewareMetadata[]> = {};
	const unresolved: string[] = [];
	const metadataForMiddleware = (expression: ts.Expression): MiddlewareMetadata | undefined => {
		const guard = requireAuthMiddleware(expression, routeFile, authentication);

		if (guard) {
			diagnostics.push(...guard.diagnostics);
			return guard.metadata;
		}

		const metadata = middlewareExpressionMetadata(expression, routeFile, middlewareByName, read);

		if (metadata) {
			return middlewareMetadata(
				cwd,
				parser,
				routeFile,
				metadata.name,
				metadata.contract,
				routeFile,
			);
		}

		const unwrapped = unwrapExpression(expression);

		if (!ts.isIdentifier(unwrapped)) {
			return;
		}

		const source = imports.get(unwrapped.text);
		const declaration = source && exportedDeclaration(cwd, source, parser, read);

		if (!declaration) {
			return;
		}

		return middlewareMetadata(
			cwd,
			parser,
			routeFile,
			unwrapped.text,
			declaration.contract,
			declaration.file,
		);
	};

	for (const property of objectProperties(routeConfig)) {
		if (propertyName(property.name) === "middleware") {
			const expressions = middlewareExpressions(property.initializer);
			unresolved.push(...expressions.unresolved);

			for (const expression of expressions.resolved) {
				const metadata = metadataForMiddleware(expression);

				if (metadata) {
					route.push(metadata);
				} else {
					unresolved.push(expression.getText());
				}
			}
		}
	}

	for (const property of objectProperties(routeConfig)) {
		const method = propertyName(property.name);

		if (!method || !httpMethods.has(method)) {
			continue;
		}

		const routeContract = createRouteObject(property.initializer);

		if (!routeContract) {
			continue;
		}

		const entries: MiddlewareMetadata[] = [];

		for (const routeProperty of objectProperties(routeContract)) {
			if (propertyName(routeProperty.name) !== "middleware") {
				continue;
			}

			const expressions = middlewareExpressions(routeProperty.initializer);
			unresolved.push(...expressions.unresolved);

			for (const expression of expressions.resolved) {
				const metadata = metadataForMiddleware(expression);

				if (metadata) {
					entries.push(metadata);
				} else {
					unresolved.push(expression.getText());
				}
			}
		}

		methods[method] = entries;
	}

	return { route, methods, unresolved, diagnostics };
}

/**
 * Extracts string literals from an object property's array value.
 *
 * @param source - The object literal to read from
 * @param property - The property name to inspect
 * @returns The string values found in the property's array, or an empty array when the property is missing or not an array of strings
 */
function stringArrayProperty(source: ts.ObjectLiteralExpression, property: string): string[] {
	const item = objectProperty(source, property);

	if (!item || !ts.isArrayLiteralExpression(item.initializer)) {
		return [];
	}

	return item.initializer.elements.flatMap((element) => {
		const expression = unwrapExpression(element);
		return ts.isStringLiteralLike(expression) ? [expression.text] : [];
	});
}

/**
 * Creates metadata for a middleware declaration and remembers the contract it was read from.
 *
 * @param declarationFile - The file that declares the contract, which differs from `file` for
 *   middleware a route file imports
 * @returns Middleware metadata including its source file, name, required context keys and
 *   services, provided context keys and types, and rejected keys.
 */
function middlewareMetadata(
	cwd: string,
	parser: ts.SourceFileParser,
	file: string,
	name: string,
	declaration: MiddlewareDeclaration,
	declarationFile: string,
): MiddlewareMetadata {
	const { contract } = declaration;
	const provides = middlewareProvides(cwd, declarationFile, contract, parser);
	const requirement = declaration.requirement
		? requirementContract(cwd, declaration.requirement, parser)
		: { diagnostics: [] };
	const inferred = middlewareNextProvidesTypes(contract);
	const metadata: MiddlewareMetadata = {
		file,
		name,
		requires: stringArrayProperty(contract, "requires"),
		...(requirement.services && { requiresServices: requirement.services }),
		provides: provides.keys,
		providesTypes: Object.fromEntries(
			provides.keys.map((provided) => [
				provided,
				provides.types[provided] ?? inferred[provided] ?? "unknown",
			]),
		),
		rejects: middlewareRejects(contract),
		security: middlewareSecurity(contract),
		permissions: middlewarePermissions(contract),
	};

	middlewareContracts.set(metadata, {
		file: declarationFile,
		contract,
		providesUnresolved: provides.unresolved,
		requirementDiagnostics: requirement.diagnostics,
	});
	return metadata;
}

function middlewareOpenApi(
	contract: ts.ObjectLiteralExpression,
): ts.ObjectLiteralExpression | undefined {
	const property = objectProperty(contract, "openapi");
	return property ? objectLiteral(property.initializer) : undefined;
}

function middlewarePermissions(contract: ts.ObjectLiteralExpression): string[] {
	const openapi = middlewareOpenApi(contract);
	return openapi ? stringArrayProperty(openapi, "permissions") : [];
}

function middlewareSecurity(contract: ts.ObjectLiteralExpression): Array<Record<string, string[]>> {
	const openapi = middlewareOpenApi(contract);
	const property = openapi && objectProperty(openapi, "security");
	const expression = property && unwrapExpression(property.initializer);
	if (!expression || !ts.isArrayLiteralExpression(expression)) return [];
	return expression.elements.flatMap((element) => {
		const object = objectLiteral(element);
		if (!object) return [];
		return [
			Object.fromEntries(
				objectProperties(object).flatMap((item) => {
					const name = propertyName(item.name);
					const value = unwrapExpression(item.initializer);
					return name && ts.isArrayLiteralExpression(value)
						? [
								[
									name,
									value.elements.flatMap((entry) =>
										ts.isStringLiteralLike(entry) ? [entry.text] : [],
									),
								],
							]
						: [];
				}),
			),
		];
	});
}

function middlewareRejects(contract: ts.ObjectLiteralExpression): MiddlewareRejectMetadata[] {
	const item = objectProperty(contract, "rejects");
	const rejects = item ? objectLiteral(item.initializer) : undefined;

	if (!rejects) {
		return [];
	}

	return objectProperties(rejects).flatMap((property) => {
		const type = propertyName(property.name);
		const reject = objectLiteral(property.initializer);

		if (!type || !reject) {
			return [];
		}

		const statusProperty = objectProperty(reject, "status");
		const schemaProperty = objectProperty(reject, "schema");
		const descriptionProperty = objectProperty(reject, "description");
		const description = descriptionProperty && unwrapExpression(descriptionProperty.initializer);
		const status = statusProperty ? numericValue(statusProperty.initializer) : undefined;

		if (status === undefined) {
			return [];
		}

		return [
			{
				type,
				status,
				...(description && ts.isStringLiteralLike(description)
					? { description: description.text }
					: {}),
				...(schemaProperty ? { schema: schemaProperty.initializer.getText() } : {}),
			},
		];
	});
}

/**
 * Extracts the context keys and value types provided by a middleware contract.
 *
 * `provides` may be an object literal or a `const` object literal it names, declared locally or
 * imported. Anything else, including spreads and computed keys, is reported as unresolved rather
 * than read as providing nothing.
 *
 * @param file - The module that declares the contract, relative to `cwd`
 * @returns The provided keys, their inferred types, and whether the declaration could be read
 */
function middlewareProvides(
	cwd: string,
	file: string,
	contract: ts.ObjectLiteralExpression,
	parser: ts.SourceFileParser,
): {
	keys: string[];
	types: Record<string, string>;
	unresolved: boolean;
} {
	const value = propertyValue(contract, "provides");

	if (!value) {
		return { keys: [], types: {}, unresolved: false };
	}

	const expression = unwrapExpression(value);
	const provides = ts.isIdentifier(expression)
		? boundDeclaration(cwd, file, expression.text, parser, objectLiteral)?.contract
		: objectLiteral(expression);
	const entries = provides?.properties.map((property) => {
		const name =
			ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property)
				? propertyName(property.name)
				: undefined;

		return name === undefined
			? undefined
			: ([
					name,
					ts.isPropertyAssignment(property) ? zodType(property.initializer) : "unknown",
				] as const);
	});

	if (!entries || entries.some((entry) => entry === undefined)) {
		return { keys: [], types: {}, unresolved: true };
	}

	const resolved = entries as ReadonlyArray<readonly [string, string]>;
	return {
		keys: resolved.map(([key]) => key),
		types: Object.fromEntries(resolved),
		unresolved: false,
	};
}

/**
 * Infers context value types supplied to the middleware's `next()` call.
 *
 * @returns A record mapping each context key to its inferred type.
 */
function middlewareNextProvidesTypes(contract: ts.ObjectLiteralExpression): Record<string, string> {
	const nextCtx = middlewareNextContext(contract);

	if (!nextCtx) {
		return {};
	}

	const inputTypes = middlewareInputTypes(contract);
	const result: Record<string, string> = {};

	for (const property of objectProperties(nextCtx)) {
		const name = propertyName(property.name);

		if (name) {
			result[name] = typeForExpression(property.initializer, inputTypes);
		}
	}

	return result;
}

/**
 * Finds the context object passed to `next()` in a middleware's `run` function.
 *
 * @param contract - The middleware contract object.
 * @returns The first object literal passed to `next()`, or `undefined` if none is found.
 */
function middlewareNextContext(
	contract: ts.ObjectLiteralExpression,
): ts.ObjectLiteralExpression | undefined {
	const run = objectProperty(contract, "run");

	if (!run) {
		return;
	}

	let context: ts.ObjectLiteralExpression | undefined;

	const visit = (node: ts.Node): void => {
		if (context) {
			return;
		}

		if (ts.isCallExpression(node) && callName(node) === "next" && node.arguments[0] !== undefined) {
			context = objectLiteral(node.arguments[0]);
			return;
		}

		ts.forEachChild(node, visit);
	};

	visit(run.initializer);
	return context;
}

/**
 * Infers input field types declared by a middleware contract.
 *
 * @param contract - Middleware contract object literal
 * @returns A map of `location.field` paths to inferred type strings
 */
function middlewareInputTypes(contract: ts.ObjectLiteralExpression): Map<string, string> {
	const input = objectProperty(contract, "input");
	const inputObject = input ? objectLiteral(input.initializer) : undefined;
	const result = new Map<string, string>();

	if (!inputObject) {
		return result;
	}

	for (const location of objectProperties(inputObject)) {
		const locationName = propertyName(location.name);
		const schema = zodObjectShape(location.initializer);

		if (!locationName || !schema) {
			continue;
		}

		for (const property of objectProperties(schema)) {
			const name = propertyName(property.name);

			if (!name) {
				continue;
			}

			result.set(`${locationName}.${name}`, zodType(property.initializer));
		}
	}

	return result;
}

/** A middleware declaration: its contract object, and the requirement interface it was given. */
type MiddlewareDeclaration = {
	contract: ts.ObjectLiteralExpression;
	/** The `Requirements` type argument of `createMiddleware<Requirements>()`, and its module. */
	requirement?: { file: string; type: ts.TypeNode } | undefined;
};

/**
 * Reads middleware declarations: `createMiddleware({ ... })`, and the typed helper form, either
 * `defineCacheMiddleware({ ... })` where the helper is a `const` or relative import bound to
 * `createMiddleware<CacheRequirements>()`, or the inline `createMiddleware<CacheRequirements>()({ ... })`.
 * Neither runs the module.
 */
function middlewareReader(
	cwd: string,
	parser: ts.SourceFileParser,
): DeclarationReader<MiddlewareDeclaration> {
	return (expression, file) => {
		const unwrapped = unwrapExpression(expression);
		const contract = ts.isCallExpression(unwrapped) && objectLiteral(unwrapped.arguments[0]);

		if (!contract) {
			return;
		}

		if (callName(unwrapped) === "createMiddleware") {
			return { contract };
		}

		const requirement = middlewareRequirement(cwd, file, unwrapped.expression, parser);
		return requirement && { contract, requirement };
	};
}

/**
 * Resolves a middleware expression to its declaration contract.
 *
 * @param expression - The middleware expression to inspect.
 * @param file - The module containing `expression`, relative to the project root.
 * @param middlewareByName - A lookup of locally declared middleware contracts by name.
 * @returns The middleware name and declaration when the expression resolves, or `undefined` otherwise.
 */
function middlewareExpressionMetadata(
	expression: ts.Expression,
	file: string,
	middlewareByName: Map<string, MiddlewareDeclaration>,
	read: DeclarationReader<MiddlewareDeclaration>,
): { name: string; contract: MiddlewareDeclaration } | undefined {
	const unwrapped = unwrapExpression(expression);

	if (ts.isIdentifier(unwrapped)) {
		const contract = middlewareByName.get(unwrapped.text);

		if (contract) {
			return { name: unwrapped.text, contract };
		}
	}

	const inline = read(unwrapped, file);

	if (inline) {
		return { name: callName(unwrapped) ?? "createMiddleware", contract: inline };
	}
}

/**
 * Extracts middleware expressions from an expression or middleware array literal.
 *
 * Spread elements are reported as unresolved because their contents run at
 * runtime but cannot be statically analyzed.
 *
 * @param expression - The expression to inspect
 * @returns The resolvable expressions and descriptions of unresolved entries
 */
function middlewareExpressions(expression: ts.Expression): {
	resolved: ts.Expression[];
	unresolved: string[];
} {
	const unwrapped = unwrapExpression(expression);

	if (ts.isArrayLiteralExpression(unwrapped)) {
		const resolved: ts.Expression[] = [];
		const unresolved: string[] = [];

		for (const element of unwrapped.elements) {
			if (ts.isSpreadElement(element)) {
				unresolved.push(element.getText());
			} else {
				resolved.push(element as ts.Expression);
			}
		}

		return { resolved, unresolved };
	}

	return { resolved: [unwrapped], unresolved: [] };
}
