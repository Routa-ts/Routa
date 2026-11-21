import { statSync } from "node:fs";
import { dirname, join } from "node:path";
import * as ts from "./typescript.js";

/**
 * Removes TypeScript wrapper expressions and returns the inner expression.
 */
export function unwrapExpression(expression: ts.Expression): ts.Expression {
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
 * Returns a static property name, excluding computed properties.
 */
export function propertyName(name: ts.PropertyName): string | undefined {
	if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) {
		return name.text;
	}
}

/**
 * Returns the identifier or property name invoked by an expression.
 */
export function callName(expression: ts.Expression): string | undefined {
	const callee = ts.isCallExpression(expression)
		? unwrapExpression(expression.expression)
		: unwrapExpression(expression);

	if (ts.isIdentifier(callee)) {
		return callee.text;
	}

	if (ts.isPropertyAccessExpression(callee)) {
		return callee.name.text;
	}
}

/**
 * Returns property assignments declared by an object literal.
 */
export function objectProperties(object: ts.ObjectLiteralExpression): ts.PropertyAssignment[] {
	return object.properties.filter(ts.isPropertyAssignment);
}

/**
 * Finds a named property assignment in an object literal.
 */
export function objectProperty(
	object: ts.ObjectLiteralExpression,
	name: string,
): ts.PropertyAssignment | undefined {
	return objectProperties(object).find((property) => propertyName(property.name) === name);
}

/**
 * Returns the value of a named object literal property, reading shorthand
 * properties such as `{ query }` as their identifier.
 */
export function propertyValue(
	object: ts.ObjectLiteralExpression,
	name: string,
): ts.Expression | undefined {
	for (const property of object.properties) {
		if (ts.isPropertyAssignment(property) && propertyName(property.name) === name) {
			return property.initializer;
		}

		if (
			ts.isShorthandPropertyAssignment(property)
			&& ts.isIdentifier(property.name)
			&& property.name.text === name
		) {
			return property.name;
		}
	}
}

/**
 * Resolves an expression node to an object literal when possible.
 */
export function objectLiteral(node: ts.Node | undefined): ts.ObjectLiteralExpression | undefined {
	if (!node || !ts.isExpression(node)) {
		return;
	}

	const unwrapped = unwrapExpression(node);
	return ts.isObjectLiteralExpression(unwrapped) ? unwrapped : undefined;
}

/**
 * Finds the initializer for a local variable binding.
 */
function localInitializer(sourceFile: ts.SourceFile, name: string): ts.Expression | undefined {
	for (const statement of sourceFile.statements) {
		if (!ts.isVariableStatement(statement)) {
			continue;
		}

		for (const declaration of statement.declarationList.declarations) {
			if (
				ts.isIdentifier(declaration.name)
				&& declaration.name.text === name
				&& declaration.initializer
			) {
				return declaration.initializer;
			}
		}
	}
}

/**
 * Resolves a relative module specifier to an existing TypeScript file.
 *
 * @param cwd - The project root used to resolve candidate paths.
 * @param fromFile - The file containing the import or re-export.
 * @param specifier - The module specifier to resolve.
 * @returns The first matching file path relative to `cwd`, or `undefined` if no relative file exists.
 */
export function resolveImportFile(
	cwd: string,
	fromFile: string,
	specifier: string,
): string | undefined {
	if (!specifier.startsWith(".")) {
		return;
	}

	const base = join(dirname(fromFile), specifier);
	const candidates = [
		base,
		base.endsWith(".js") ? `${base.slice(0, -3)}.ts` : undefined,
		base.endsWith(".ts") ? base : `${base}.ts`,
		join(base, "index.ts"),
	].filter((item): item is string => Boolean(item));

	return candidates.find((candidate) => isFile(join(cwd, candidate)));
}

/**
 * Extracts the exported route configuration object from a source file.
 *
 * Follows `export default identifier` to a local initializer when possible.
 *
 * @param sourceFile - The parsed TypeScript source file to inspect
 * @returns The exported route configuration object, if present
 */
export function routeConfigObject(
	sourceFile: ts.SourceFile,
): ts.ObjectLiteralExpression | undefined {
	for (const statement of sourceFile.statements) {
		if (!ts.isExportAssignment(statement) || statement.isExportEquals) {
			continue;
		}

		const expression = resolveExportedExpression(sourceFile, statement.expression);
		return routeRootObject(sourceFile, expression);
	}
}

/**
 * Resolves an exported expression to a local initializer when it is an identifier.
 */
function resolveExportedExpression(
	sourceFile: ts.SourceFile,
	expression: ts.Expression,
): ts.Expression {
	const unwrapped = unwrapExpression(expression);

	if (!ts.isIdentifier(unwrapped)) {
		return unwrapped;
	}

	const initializer = localInitializer(sourceFile, unwrapped.text);
	return initializer ? unwrapExpression(initializer) : unwrapped;
}

/**
 * Extracts the route configuration object from a `createRouteRoot(path)(...)` call.
 *
 * @returns The first argument as an object literal, if the expression is a `createRouteRoot` call.
 */
function routeRootObject(
	sourceFile: ts.SourceFile,
	expression: ts.Expression,
): ts.ObjectLiteralExpression | undefined {
	const unwrapped = unwrapExpression(expression);

	if (!ts.isCallExpression(unwrapped)) {
		return;
	}

	const callee = unwrapExpression(unwrapped.expression);
	const routeRootCall = ts.isIdentifier(callee)
		? localInitializer(sourceFile, callee.text)
		: ts.isCallExpression(callee)
			? callee
			: undefined;

	if (!routeRootCall || callName(unwrapExpression(routeRootCall)) !== "createRouteRoot") {
		return;
	}

	return objectLiteral(unwrapped.arguments[0]);
}

/**
 * Extracts the route contract object from a `createRoute` call.
 *
 * @param expression - The expression to inspect
 * @returns The first argument object literal when the expression is a `createRoute(...)` call; otherwise `undefined`
 */
export function createRouteObject(
	expression: ts.Expression,
): ts.ObjectLiteralExpression | undefined {
	const unwrapped = unwrapExpression(expression);

	if (!ts.isCallExpression(unwrapped) || callName(unwrapped) !== "createRoute") {
		return;
	}

	return objectLiteral(unwrapped.arguments[0]);
}

/** Whether a path is a file, so a directory named like a module does not shadow its `index.ts`. */
function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

const coreModule = "@routa-ts/core";

/**
 * The call when an expression calls the `@routa-ts/core` function `name`, such as `bearer` or
 * `requireAuth`: imported by name, possibly aliased, or called on a namespace import, as in
 * `core.requireAuth()`. An application function that shares the name is not the core one.
 */
export function coreCall(expression: ts.Expression, name: string): ts.CallExpression | undefined {
	const node = unwrapExpression(expression);
	return ts.isCallExpression(node) && coreExportName(unwrapExpression(node.expression)) === name
		? node
		: undefined;
}

/**
 * The `@routa-ts/core` export a node names: a binding its module imports from core, possibly
 * aliased, or a member of a namespace import of core, such as `core.requireAuth`.
 */
export function coreExportName(node: ts.Node): string | undefined {
	const imports = coreImports(node.getSourceFile());

	if (ts.isIdentifier(node)) {
		return imports.named.get(node.text);
	}

	return ts.isPropertyAccessExpression(node)
		&& ts.isIdentifier(node.expression)
		&& imports.namespaces.has(node.expression.text)
		? node.name.text
		: undefined;
}

const coreImportsByFile = new WeakMap<
	ts.SourceFile,
	{ named: Map<string, string>; namespaces: Set<string> }
>();

/**
 * What a module imports from `@routa-ts/core`: each local name and the export it names, and the
 * names of its namespace imports.
 */
function coreImports(sourceFile: ts.SourceFile): {
	named: Map<string, string>;
	namespaces: Set<string>;
} {
	const cached = coreImportsByFile.get(sourceFile);

	if (cached) {
		return cached;
	}

	const imports = { named: new Map<string, string>(), namespaces: new Set<string>() };

	for (const statement of sourceFile.statements) {
		const bindings =
			ts.isImportDeclaration(statement)
			&& ts.isStringLiteral(statement.moduleSpecifier)
			&& statement.moduleSpecifier.text === coreModule
				? statement.importClause?.namedBindings
				: undefined;

		if (bindings && ts.isNamespaceImport(bindings)) {
			imports.namespaces.add(bindings.name.text);
		} else if (bindings && ts.isNamedImports(bindings)) {
			for (const element of bindings.elements) {
				imports.named.set(element.name.text, element.propertyName?.text ?? element.name.text);
			}
		}
	}

	coreImportsByFile.set(sourceFile, imports);
	return imports;
}
