import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import {
	callName,
	objectLiteral,
	objectProperties,
	objectProperty,
	propertyName,
	unwrapExpression,
} from "../ast.js";
import { parseTypeScriptFile } from "../declarations.js";
import type { Diagnostic, ProjectModel } from "../project.js";
import { walk } from "../route-discovery.js";
import { middlewareRequirement } from "../services.js";
import * as ts from "../typescript.js";

export function runResultShapeDiagnostics({ cwd, parser }: ProjectModel): Diagnostic[] {
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
