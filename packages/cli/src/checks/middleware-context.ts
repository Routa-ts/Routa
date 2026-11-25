import { reservedAuthContext, reservedContext } from "@routa-ts/contract-rules";
import { objectLiteral, propertyName, propertyValue, unwrapExpression } from "../ast.js";
import { middlewareContract } from "../middleware-contracts.js";
import type { Diagnostic, ProjectModel } from "../project.js";
import * as ts from "../typescript.js";

/**
 * Reports middleware context Routa cannot accept: `ctx.services`, `ctx.requestId`,
 * `ctx.correlationId`, and `ctx.logger`, which it reserves, whether provided or passed to
 * `next()`, `provides` it cannot read from source, and a requirement interface it cannot read.
 *
 * @param routes - Route metadata whose middleware chains are checked, each contract once
 */
export function middlewareContextDiagnostics({
	routes,
	authentication,
}: ProjectModel): Diagnostic[] {
	const authenticated = authentication !== undefined;
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
