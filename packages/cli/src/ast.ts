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
export function localInitializer(
	sourceFile: ts.SourceFile,
	name: string,
): ts.Expression | undefined {
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
