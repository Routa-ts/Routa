import {
	callName,
	objectLiteral,
	objectProperties,
	propertyName,
	unwrapExpression,
} from "./ast.js";
import * as ts from "./typescript.js";

/**
 * Extracts the shape object from a Zod `object(...)` expression.
 *
 * @param expression - The expression to inspect
 * @returns The object literal shape when the expression is a `object(...)` call, `undefined` otherwise
 */
export function zodObjectShape(expression: ts.Expression): ts.ObjectLiteralExpression | undefined {
	const unwrapped = unwrapExpression(expression);

	if (!ts.isCallExpression(unwrapped) || callName(unwrapped) !== "object") {
		return;
	}

	return objectLiteral(unwrapped.arguments[0]);
}

/**
 * Infers a TypeScript type string from a Zod expression.
 *
 * @returns The inferred type string, or `"unknown"` when the expression is not recognized.
 */
export function zodType(expression: ts.Expression): string {
	const unwrapped = unwrapExpression(expression);

	if (!ts.isCallExpression(unwrapped)) {
		return "unknown";
	}

	const call = callName(unwrapped);
	const callee = unwrapExpression(unwrapped.expression);

	if (call === "optional" && ts.isPropertyAccessExpression(callee)) {
		return `${zodType(callee.expression)} | undefined`;
	}

	if (call === "object") {
		const shape = objectLiteral(unwrapped.arguments[0]);

		if (!shape) {
			return "Record<string, unknown>";
		}

		return zodObjectType(shape);
	}

	if (call === "array") {
		return `Array<${unwrapped.arguments[0] ? zodType(unwrapped.arguments[0]) : "unknown"}>`;
	}

	if (
		call === "enum"
		&& unwrapped.arguments[0] !== undefined
		&& ts.isArrayLiteralExpression(unwrapped.arguments[0])
	) {
		const values = unwrapped.arguments[0].elements.flatMap((element) => {
			const value = unwrapExpression(element);
			return ts.isStringLiteralLike(value) ? [JSON.stringify(value.text)] : [];
		});

		return values.length > 0 ? values.join(" | ") : "string";
	}

	if (call === "string") {
		return "string";
	}

	if (call === "number" || call === "int") {
		return "number";
	}

	if (call === "boolean" || call === "stringbool") {
		return "boolean";
	}

	return "unknown";
}

/**
 * Builds a readonly object type from a Zod object shape.
 *
 * @param shape - The object literal that defines the Zod shape
 * @returns A TypeScript-like object type for the shape
 */
function zodObjectType(shape: ts.ObjectLiteralExpression): string {
	const properties = objectProperties(shape).flatMap((property) => {
		const name = propertyName(property.name);

		if (!name) {
			return [];
		}

		const optional = isZodOptional(property.initializer);
		return [
			`\treadonly ${JSON.stringify(name)}${optional ? "?" : ""}: ${zodType(property.initializer)};`,
		];
	});

	return properties.length > 0 ? `{\n${properties.join("\n")}\n}` : "{}";
}

/**
 * Determines whether an expression is a Zod optional schema.
 *
 * @param expression - The expression to inspect
 * @returns `true` if the expression is an `optional(...)` call, `false` otherwise
 */
function isZodOptional(expression: ts.Expression): boolean {
	const unwrapped = unwrapExpression(expression);

	if (!ts.isCallExpression(unwrapped)) {
		return false;
	}

	return callName(unwrapped) === "optional";
}

/**
 * Infers a string representation of the type produced by an expression.
 *
 * @param expression - The expression to analyze
 * @param inputTypes - Known types for `input` access paths
 * @returns A TypeScript-like type string for the expression
 */
export function typeForExpression(
	expression: ts.Expression,
	inputTypes: Map<string, string>,
): string {
	const unwrapped = unwrapExpression(expression);

	if (ts.isStringLiteralLike(unwrapped) || ts.isTemplateExpression(unwrapped)) {
		return "string";
	}

	if (ts.isNumericLiteral(unwrapped)) {
		return "number";
	}

	if (
		unwrapped.kind === ts.SyntaxKind.TrueKeyword
		|| unwrapped.kind === ts.SyntaxKind.FalseKeyword
	) {
		return "boolean";
	}

	if (ts.isObjectLiteralExpression(unwrapped)) {
		return objectType(unwrapped, inputTypes);
	}

	if (ts.isConditionalExpression(unwrapped)) {
		return mergeTypes(
			typeForExpression(unwrapped.whenTrue, inputTypes),
			typeForExpression(unwrapped.whenFalse, inputTypes),
		);
	}

	if (
		ts.isBinaryExpression(unwrapped)
		&& unwrapped.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken
	) {
		return removeUndefined(
			typeForExpression(unwrapped.left, inputTypes),
			typeForExpression(unwrapped.right, inputTypes),
		);
	}

	const inputType = inputAccessType(unwrapped, inputTypes);

	if (inputType) {
		return inputType;
	}

	return "unknown";
}

/**
 * Formats an object literal as a readonly TypeScript object type.
 *
 * @returns A TypeScript type string with one readonly property per named object literal member, or `{}` when no named properties are present.
 */
function objectType(object: ts.ObjectLiteralExpression, inputTypes: Map<string, string>): string {
	const properties = objectProperties(object)
		.map((property) => {
			const name = propertyName(property.name);
			return name
				? `readonly ${JSON.stringify(name)}: ${typeForExpression(property.initializer, inputTypes)};`
				: "";
		})
		.filter(Boolean);

	return properties.length > 0 ? `{\n${properties.map((item) => `\t${item}`).join("\n")}\n}` : "{}";
}

/**
 * Merges two type representations into a combined type.
 *
 * @param left - The first type representation.
 * @param right - The second type representation.
 * @returns The shared object type when both inputs are object types, otherwise a union or the matching type.
 */
function mergeTypes(left: string, right: string): string {
	const leftObject = parseObjectType(left);
	const rightObject = parseObjectType(right);

	if (!leftObject || !rightObject) {
		return left === right ? left : `${left} | ${right}`;
	}

	const keys = Array.from(
		new Set([...Object.keys(leftObject), ...Object.keys(rightObject)]),
	).sort();
	const lines = keys.map((key) => {
		const leftValue = leftObject[key];
		const rightValue = rightObject[key];
		const optional = leftValue && rightValue ? "" : "?";
		const value =
			leftValue && rightValue ? mergeTypes(leftValue, rightValue) : (leftValue ?? rightValue);
		return `\treadonly ${JSON.stringify(key)}${optional}: ${value};`;
	});

	return `{\n${lines.join("\n")}\n}`;
}

/**
 * Parses a readonly object type string into a key-to-type map.
 *
 * @param type - The type string to parse
 * @returns An object map of property names to their declared types, or `undefined` if the string is not an object type
 */
function parseObjectType(type: string): Record<string, string> | undefined {
	const trimmed = type.trim();

	if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
		return;
	}

	const result: Record<string, string> = {};
	for (const [, name, value] of trimmed.matchAll(/readonly "([^"]+)"\??: ([^;]+);/g)) {
		result[name!] = value!;
	}

	return result;
}

/**
 * Removes `undefined` from a union type string and merges it with a fallback type.
 *
 * @param left - The type string to narrow
 * @param fallback - The type string to preserve in the result
 * @returns The narrowed type string, or a merged type when the fallback adds information
 */
function removeUndefined(left: string, fallback: string): string {
	const narrowed = left
		.split("|")
		.map((item) => item.trim())
		.filter((item) => item !== "undefined")
		.join(" | ");

	return narrowed === fallback ? narrowed : mergeTypes(narrowed || "unknown", fallback);
}

/**
 * Looks up the inferred type for an input access expression.
 *
 * @param expression - The expression to inspect
 * @param inputTypes - The map of input access paths to inferred types
 * @returns The inferred type for the access path, or `undefined` if no type is known
 */
function inputAccessType(
	expression: ts.Expression,
	inputTypes: Map<string, string>,
): string | undefined {
	const path = inputAccessPath(expression);
	return path ? inputTypes.get(path) : undefined;
}

/**
 * Resolves an `input.<location>.<field>` access path.
 *
 * @param expression - The expression to inspect
 * @returns The access path as `<location>.<field>` when the expression matches, `undefined` otherwise
 */
function inputAccessPath(expression: ts.Expression): string | undefined {
	const segments: string[] = [];
	let current = unwrapExpression(expression);

	while (ts.isPropertyAccessExpression(current) || ts.isElementAccessExpression(current)) {
		if (ts.isPropertyAccessExpression(current)) {
			segments.unshift(current.name.text);
			current = unwrapExpression(current.expression);
			continue;
		}

		const argument = unwrapExpression(current.argumentExpression);
		if (!ts.isStringLiteralLike(argument)) {
			return;
		}

		segments.unshift(argument.text);
		current = unwrapExpression(current.expression);
	}

	if (!ts.isIdentifier(current) || current.text !== "input" || segments.length !== 2) {
		return;
	}

	return `${segments[0]}.${segments[1]}`;
}
