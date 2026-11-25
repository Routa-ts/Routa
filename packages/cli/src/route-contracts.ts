import { join } from "node:path";
import {
	callName,
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
	boundDeclaration,
	exportedDeclaration,
	type ModuleDeclaration,
	namedImportMap,
	parseTypeScriptFile,
} from "./declarations.js";
import type { RouteDeprecationMetadata, RouteMethodInputMetadata } from "./project.js";
import * as ts from "./typescript.js";

export const httpMethods = new Set(["get", "post", "put", "patch", "delete", "head"]);

/**
 * Extracts route method contract metadata from a route file.
 *
 * @param file - Path to the route file
 * @returns Parsed contract metadata and whether a route config object was found
 */
export function parseRouteContract(
	file: string,
	parser: ts.SourceFileParser,
): {
	configFound: boolean;
	explicitOptions: boolean;
	contract: Record<
		string,
		{
			responses: number[];
			responseTypes: string[];
			outcomes: ResponseOutcomeDeclaration[];
			inputs: RouteMethodInputMetadata;
			deprecation?: RouteDeprecationMetadata | undefined;
		}
	>;
} {
	const contract: Record<
		string,
		{
			responses: number[];
			responseTypes: string[];
			outcomes: ResponseOutcomeDeclaration[];
			inputs: RouteMethodInputMetadata;
			deprecation?: RouteDeprecationMetadata | undefined;
		}
	> = {};
	const sourceFile = parseTypeScriptFile(file, parser);
	const routeConfig = routeConfigObject(sourceFile);
	let explicitOptions = false;

	if (!routeConfig) {
		return { configFound: false, explicitOptions, contract };
	}

	for (const property of objectProperties(routeConfig)) {
		const method = propertyName(property.name);

		if (method === "options") {
			explicitOptions = true;
			continue;
		}

		if (!method || !httpMethods.has(method)) {
			continue;
		}

		const routeContract = createRouteObject(property.initializer);

		if (!routeContract) {
			continue;
		}

		contract[method] = {
			responses: responseStatuses(routeContract),
			responseTypes: responseTypeKeys(routeContract),
			outcomes: responseOutcomes(routeContract),
			inputs: routeInputs(routeContract),
			deprecation: routeDeprecation(routeContract),
		};
	}

	return { configFound: true, explicitOptions, contract };
}

function routeDeprecation(
	routeContract: ts.ObjectLiteralExpression,
): RouteDeprecationMetadata | undefined {
	const property = objectProperty(routeContract, "deprecation");
	const deprecation = property ? objectLiteral(property.initializer) : undefined;
	const replacement = deprecation && objectProperty(deprecation, "replacement");
	const expression = replacement && unwrapExpression(replacement.initializer);
	return expression && ts.isStringLiteralLike(expression)
		? { replacement: expression.text }
		: undefined;
}

/**
 * Collects the declared response type keys from a route contract.
 *
 * @param routeContract - The route contract object literal
 * @returns The property names declared under `responses`
 */
function responseTypeKeys(routeContract: ts.ObjectLiteralExpression): string[] {
	const responses = objectProperty(routeContract, "responses");
	const responsesObject = responses ? objectLiteral(responses.initializer) : undefined;

	if (!responsesObject) {
		return [];
	}

	return objectProperties(responsesObject).flatMap((property) => {
		const name = propertyName(property.name);
		return name ? [name] : [];
	});
}

/** A named route outcome as written in source. `status` is set only for a numeric literal. */
export type ResponseOutcomeDeclaration = {
	name: string;
	status?: number | undefined;
	hasSchema: boolean;
};

function responseOutcomes(routeContract: ts.ObjectLiteralExpression): ResponseOutcomeDeclaration[] {
	const responses = objectProperty(routeContract, "responses");
	const responsesObject = responses ? objectLiteral(responses.initializer) : undefined;

	if (!responsesObject) {
		return [];
	}

	return objectProperties(responsesObject).flatMap((property) => {
		const name = propertyName(property.name);
		const outcome = objectLiteral(property.initializer);

		if (!name || !outcome) {
			return [];
		}

		const status = objectProperty(outcome, "status");
		return [
			{
				name,
				...(status ? { status: numericValue(status.initializer) } : {}),
				hasSchema: Boolean(propertyValue(outcome, "schema")),
			},
		];
	});
}

/**
 * Finds the `createCookie({ ... })` declaration a module binds to a name, whether the module
 * declares it or imports it. Imports follow relative modules and re-export chains, the way
 * middleware does.
 *
 * @param file - The module that uses the cookie, relative to `cwd`
 * @param name - The cookie's local name in `file`
 * @returns The declaring file, declared name, and `createCookie` argument, or `undefined`
 */
export function cookieDeclaration(
	cwd: string,
	file: string,
	name: string,
	parser: ts.SourceFileParser,
): ModuleDeclaration | undefined {
	return boundDeclaration(cwd, file, name, parser, createCookieObject);
}

/**
 * Follows a module's named import to the `const` declaration behind it, through relative modules
 * and re-export chains, the way cookie handles and middleware resolve. Schemas the module
 * declares itself are not looked up here.
 *
 * @param file - The module that imports the schema, relative to `cwd`
 * @param name - The schema's local name in `file`
 * @returns The declaring file and declared name, or `undefined` when the import cannot be followed
 */
export function importedSchemaDeclaration(
	cwd: string,
	file: string,
	name: string,
	parser: ts.SourceFileParser,
): { file: string; name: string } | undefined {
	const source = namedImportMap(cwd, file, parseTypeScriptFile(join(cwd, file), parser)).get(name);
	return source && exportedDeclaration(cwd, source, parser, (expression) => expression);
}

/**
 * Extracts the configuration object from a `createCookie` call.
 */
function createCookieObject(expression: ts.Expression): ts.ObjectLiteralExpression | undefined {
	const unwrapped = unwrapExpression(expression);

	if (!ts.isCallExpression(unwrapped) || callName(unwrapped) !== "createCookie") {
		return;
	}

	return objectLiteral(unwrapped.arguments[0]);
}

/**
 * Extracts the declared input locations from a route contract.
 *
 * @param routeContract - The route contract object literal to inspect.
 * @returns An object indicating whether `params`, `query`, `headers`, `cookies`, and `body` inputs are declared.
 */
function routeInputs(routeContract: ts.ObjectLiteralExpression): RouteMethodInputMetadata {
	const input = objectProperty(routeContract, "input");
	const inputObject = input ? objectLiteral(input.initializer) : undefined;

	return {
		params: Boolean(inputObject && propertyValue(inputObject, "params")),
		query: Boolean(inputObject && propertyValue(inputObject, "query")),
		headers: Boolean(inputObject && propertyValue(inputObject, "headers")),
		cookies: Boolean(inputObject && propertyValue(inputObject, "cookies")),
		body: Boolean(inputObject && propertyValue(inputObject, "body")),
	};
}

/**
 * Collects declared response status codes from a route contract.
 *
 * @param routeContract - The route contract object literal
 * @returns The numeric status codes declared under `responses`
 */
function responseStatuses(routeContract: ts.ObjectLiteralExpression): number[] {
	const responses = objectProperty(routeContract, "responses");

	if (!responses) {
		return [];
	}

	const statuses: number[] = [];
	const visit = (node: ts.Node) => {
		if (ts.isPropertyAssignment(node) && propertyName(node.name) === "status") {
			const status = numericValue(node.initializer);

			if (status !== undefined) {
				statuses.push(status);
			}
		}

		ts.forEachChild(node, visit);
	};
	visit(responses.initializer);

	return statuses;
}

/**
 * Extracts a numeric literal value from an expression.
 *
 * @param expression - The expression to inspect
 * @returns The numeric value, or `undefined` when the expression is not a numeric literal
 */
export function numericValue(expression: ts.Expression): number | undefined {
	const unwrapped = unwrapExpression(expression);

	if (ts.isNumericLiteral(unwrapped)) {
		return Number(unwrapped.text);
	}
}
