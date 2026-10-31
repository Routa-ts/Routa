import { existsSync } from "node:fs";
import { join, sep } from "node:path";
import {
	callName,
	createRouteObject,
	objectLiteral,
	objectProperties,
	propertyName,
	resolveImportFile,
	routeConfigObject,
	unwrapExpression,
} from "./ast.js";
import { compareText } from "./contract-schemas.js";
import {
	boundDeclaration,
	type Diagnostic,
	namedImportMap,
	parseTypeScriptFile,
} from "./project.js";
import * as ts from "./typescript.js";

/** A service contract one scope declares, read from source. */
export type ServiceContractMetadata = {
	/** The module that exports the contract, relative to the project root. */
	file: string;
	/** The name that module exports the contract under. */
	name: string;
	/** The contract's service names, sorted. */
	names: string[];
};

/** The service contracts a route file declares: its own, and each method's. */
export type RouteServicesMetadata = {
	routeFile?: ServiceContractMetadata;
	methods?: Record<string, ServiceContractMetadata>;
};

const configFile = "src/routa.ts";

/** How many named bindings Routa follows from `services` to its `defineServices` call. */
const maxBindingDepth = 8;

/**
 * Reads the application service contract declared in `src/routa.ts` without executing it.
 *
 * The documented forms are `services: defineAppServices(factory)`, where
 * `const defineAppServices = defineServices<AppServices>()`, and the inline
 * `services: defineServices<AppServices>()(factory)`. Each binding along the way may be a local
 * `const` or a relative import. A declaration Routa cannot follow is an error, not an empty set.
 *
 * @returns The contract metadata when services are declared, diagnostics for declarations Routa
 *   cannot read, and a warning when an unreadable spread or computed key may hide `services`
 */
export function applicationServices(
	cwd: string,
	parser: ts.SourceFileParser,
): {
	services?: ServiceContractMetadata;
	diagnostics: Diagnostic[];
	warnings: Diagnostic[];
} {
	if (!existsSync(join(cwd, configFile))) {
		return { diagnostics: [], warnings: [] };
	}

	const { declaration, hidden } = servicesDeclaration(cwd, parser);
	// Tuning values may be runtime expressions, so a config Routa cannot read is not an error.
	const warnings: Diagnostic[] = hidden
		? [
				{
					code: "ROUTA_SERVICES_SPREAD_UNRESOLVED",
					severity: "warning",
					message: `The createRouta config in ${configFile} has a spread, computed key, or config argument that cannot be statically read, so application services inside it cannot be read.`,
					file: configFile,
					suggestion:
						"Declare application services as a visible services member of the createRouta object, after any spread, or spread a const object literal. Startup rejects services that routa generate could not read.",
				},
			]
		: [];

	if (!declaration) {
		return { diagnostics: [], warnings };
	}

	return {
		...declaredContract(cwd, declaration, parser, `Application services in ${configFile}`, "App"),
		warnings,
	};
}

/**
 * Reads the service contracts a route file declares on its route root and on each inline
 * `createRoute` method, in the same forms as application services, without executing the file.
 *
 * @param file - The route file, relative to `cwd`
 */
export function routeServices(
	cwd: string,
	file: string,
	parser: ts.SourceFileParser,
): { services?: RouteServicesMetadata; diagnostics: Diagnostic[] } {
	const routeConfig = routeConfigObject(parseTypeScriptFile(join(cwd, file), parser));
	const services: RouteServicesMetadata = {};
	const diagnostics: Diagnostic[] = [];
	const read = (object: ts.ObjectLiteralExpression, label: string, example: string) => {
		const node = servicesValue(object);

		if (!node) {
			return undefined;
		}

		const declared = declaredContract(cwd, { file, node }, parser, `${label} in ${file}`, example);
		diagnostics.push(...declared.diagnostics);
		return declared.services;
	};

	const routeFile = routeConfig && read(routeConfig, "Route-file services", "Orders");

	if (routeFile) {
		services.routeFile = routeFile;
	}

	for (const property of routeConfig ? objectProperties(routeConfig) : []) {
		const key = propertyName(property.name);
		const method = key && key !== "services" && createRouteObject(property.initializer);
		const contract = method && read(method, `${key.toUpperCase()} services`, "Checkout");

		if (contract) {
			services.methods = { ...services.methods, [key as string]: contract };
		}
	}

	return {
		...(services.routeFile || services.methods ? { services } : {}),
		diagnostics,
	};
}

/**
 * Follows one scope's `services` value to its contract.
 *
 * @param label - Names the declaration in messages, such as `Application services in src/routa.ts`
 * @param example - The contract name prefix the suggestion uses, such as `App`
 */
function declaredContract(
	cwd: string,
	declaration: { file: string; node: ts.Node },
	parser: ts.SourceFileParser,
	label: string,
	example: string,
): { services?: ServiceContractMetadata; diagnostics: Diagnostic[] } {
	const contract = ts.isExpression(declaration.node)
		? factoryContract(cwd, declaration.file, declaration.node, parser, 0)
		: undefined;

	if (!contract) {
		return {
			diagnostics: [
				{
					code: "ROUTA_SERVICES_UNRESOLVED",
					severity: "error",
					message: `${label} cannot be statically resolved to a service contract.`,
					file: declaration.file,
					suggestion: `Declare \`const define${example}Services = defineServices<${example}Services>();\` and set \`services: define${example}Services(factory)\`, or write \`services: defineServices<${example}Services>()(factory)\`. Each binding must be a const declaration or a relative import.`,
				},
			],
		};
	}

	return serviceContract(cwd, contract.file, contract.type, parser);
}

type ServicesMember = {
	/** The `services` member's value, and the module it is written in. */
	declaration?: { file: string; node: ts.Node } | undefined;
	/** Whether a spread, computed key, or argument Routa cannot read may hold `services`, after any visible member. */
	hidden: boolean;
};

/** Finds the `services` member of the `createRouta({ ... })` call in `src/routa.ts`. */
function servicesDeclaration(cwd: string, parser: ts.SourceFileParser): ServicesMember {
	let found: ServicesMember = { hidden: false };

	const visit = (node: ts.Node): void => {
		if (found.declaration) {
			return;
		}

		if (ts.isCallExpression(node) && callName(node.expression) === "createRouta") {
			// The config argument is read like a spread: an object literal or a `const` binding to one.
			const argument = node.arguments[0];
			const config = argument && spreadObject(cwd, configFile, argument, parser, 0);
			const member = config
				? objectServices(cwd, config.file, config.object, parser, 1)
				: { hidden: argument !== undefined };

			found = { declaration: member.declaration, hidden: found.hidden || member.hidden };

			if (found.declaration) {
				return;
			}
		}

		ts.forEachChild(node, visit);
	};

	visit(parseTypeScriptFile(join(cwd, configFile), parser));
	return found;
}

/**
 * Reads `services` from a config object in source order, so a later member replaces an earlier
 * one as it does at runtime. A spread of an object literal, or of a `const` object literal
 * declared locally or imported, is read like members written in place.
 *
 * @param file - The module containing `object`, relative to `cwd`
 */
function objectServices(
	cwd: string,
	file: string,
	object: ts.ObjectLiteralExpression,
	parser: ts.SourceFileParser,
	depth: number,
): ServicesMember {
	let found: ServicesMember = { hidden: false };

	for (const property of object.properties) {
		if (ts.isSpreadAssignment(property)) {
			const spread = spreadObject(cwd, file, property.expression, parser, depth);
			const member = spread
				? objectServices(cwd, spread.file, spread.object, parser, depth + 1)
				: { hidden: true };
			found = member.declaration
				? member
				: { declaration: found.declaration, hidden: found.hidden || member.hidden };
		} else if (ts.isComputedPropertyName(property.name)) {
			found = { ...found, hidden: true };
		} else if (propertyName(property.name) === "services") {
			// A visible member replaces whatever an earlier unreadable part held.
			found = { declaration: { file, node: memberValue(property) }, hidden: false };
		}
	}

	return found;
}

/**
 * Finds the value of a route root's or method's `services` member, including one written as
 * `["services"]`. A member Routa cannot read, such as a getter or a computed key, yields the
 * member itself, which `declaredContract` reports as unresolved instead of ignoring it.
 */
function servicesValue(object: ts.ObjectLiteralExpression): ts.Node | undefined {
	for (const property of object.properties) {
		if (ts.isSpreadAssignment(property)) {
			continue;
		}

		if (ts.isComputedPropertyName(property.name)) {
			const key = property.name.expression;

			if (ts.isStringLiteralLike(key) && key.text === "services") {
				return property;
			}
		} else if (propertyName(property.name) === "services") {
			return memberValue(property);
		}
	}
}

/**
 * The node holding an object member's value: the initializer of an assignment, or the identifier
 * of a shorthand member. Any other member, such as a method or accessor, is returned as is.
 */
function memberValue(property: ts.ObjectLiteralElementLike): ts.Node {
	return ts.isPropertyAssignment(property)
		? property.initializer
		: ts.isShorthandPropertyAssignment(property)
			? property.name
			: property;
}

/** Follows a spread expression to the object literal it spreads, when it is a `const` binding. */
function spreadObject(
	cwd: string,
	file: string,
	expression: ts.Expression,
	parser: ts.SourceFileParser,
	depth: number,
): { file: string; object: ts.ObjectLiteralExpression } | undefined {
	const node = unwrapExpression(expression);

	if (depth > maxBindingDepth) {
		return;
	}

	if (ts.isObjectLiteralExpression(node)) {
		return { file, object: node };
	}

	if (ts.isIdentifier(node)) {
		const bound = boundDeclaration(cwd, file, node.text, parser, objectLiteral);
		return bound && { file: bound.file, object: bound.contract };
	}
}

/**
 * Follows a services factory expression to the contract type of its `defineServices` call.
 *
 * @param file - The module containing `expression`, relative to `cwd`
 * @returns The contract type node and the module it appears in
 */
function factoryContract(
	cwd: string,
	file: string,
	expression: ts.Expression,
	parser: ts.SourceFileParser,
	depth: number,
): { file: string; type: ts.TypeNode } | undefined {
	const node = unwrapExpression(expression);

	if (depth > maxBindingDepth) {
		return;
	}

	if (ts.isIdentifier(node)) {
		const bound = boundDeclaration(cwd, file, node.text, parser, (initializer) => initializer);
		return bound && factoryContract(cwd, bound.file, bound.contract, parser, depth + 1);
	}

	if (!ts.isCallExpression(node) || node.arguments.length !== 1) {
		return;
	}

	return helperContract(cwd, file, node.expression, parser, depth + 1);
}

/** Follows a services helper, such as `defineAppServices`, to its `defineServices<Contract>()` call. */
function helperContract(
	cwd: string,
	file: string,
	expression: ts.Expression,
	parser: ts.SourceFileParser,
	depth: number,
): { file: string; type: ts.TypeNode } | undefined {
	const node = unwrapExpression(expression);

	if (depth > maxBindingDepth) {
		return;
	}

	if (ts.isIdentifier(node)) {
		const bound = boundDeclaration(cwd, file, node.text, parser, (initializer) => initializer);
		return bound && helperContract(cwd, bound.file, bound.contract, parser, depth + 1);
	}

	if (
		!ts.isCallExpression(node)
		|| callName(node) !== "defineServices"
		|| node.arguments.length > 0
		|| node.typeArguments?.length !== 1
	) {
		return;
	}

	return { file, type: node.typeArguments[0] as ts.TypeNode };
}

/** Resolves a contract type to its exported declaration and reads its service names. */
function serviceContract(
	cwd: string,
	file: string,
	type: ts.TypeNode,
	parser: ts.SourceFileParser,
): { services?: ServiceContractMetadata; diagnostics: Diagnostic[] } {
	const unresolved = (message: string, suggestion: string) => ({
		diagnostics: [
			{
				code: "ROUTA_SERVICES_CONTRACT_UNRESOLVED",
				severity: "error" as const,
				message,
				file,
				suggestion,
			},
		],
	});

	if (!ts.isTypeReferenceNode(type) || !ts.isIdentifier(type.typeName) || type.typeArguments) {
		return unresolved(
			`Service contract ${type.getText()} is not a named interface or type.`,
			"Declare the contract as an exported interface and pass its name: defineServices<AppServices>().",
		);
	}

	const name = type.typeName.text;
	const declaration = typeDeclaration(cwd, file, name, parser);

	if (!declaration) {
		return unresolved(
			`Service contract ${name} cannot be resolved to an interface or object type.`,
			"Declare the contract in a project module, or import it through a relative import.",
		);
	}

	if (!declaration.exportedName) {
		return unresolved(
			`Service contract ${name} in ${declaration.file} is not exported, so generated types cannot reference it.`,
			`Export ${name} from ${declaration.file}.`,
		);
	}

	const members = contractMembers(declaration.node);

	if (members.problems.length > 0) {
		return {
			diagnostics: [
				{
					code: "ROUTA_SERVICES_CONTRACT_UNSUPPORTED",
					severity: "error",
					message: `Service contract ${name} ${members.problems.join("; ")}.`,
					file: declaration.file,
					suggestion:
						"Declare each service as a required property with a plain name, directly in an interface or object type, without index signatures or extends.",
				},
			],
		};
	}

	return {
		services: {
			file: declaration.file,
			name: declaration.exportedName,
			names: members.names.sort(compareText),
		},
		diagnostics: [],
	};
}

type ContractDeclaration = ts.InterfaceDeclaration | ts.TypeAliasDeclaration;

type ResolvedContract = {
	file: string;
	node: ContractDeclaration;
	/** The name `file` exports the declaration under, when it exports it. */
	exportedName?: string | undefined;
};

/**
 * Finds the interface or type alias a module refers to by a name: its own declaration, or a named
 * import followed through re-exports.
 *
 * @param file - The module that uses the name, relative to `cwd`
 */
function typeDeclaration(
	cwd: string,
	file: string,
	name: string,
	parser: ts.SourceFileParser,
): ResolvedContract | undefined {
	const sourceFile = parseTypeScriptFile(join(cwd, file), parser);
	const node = localTypeDeclaration(sourceFile, name);

	if (node) {
		return { file, node, exportedName: localExportName(sourceFile, node) };
	}

	const source = namedImportMap(cwd, file, sourceFile).get(name);
	return source && exportedType(cwd, source.file, source.name, parser, new Set());
}

/** Finds the declaration a module exports under a name, through re-exports and `export *`. */
function exportedType(
	cwd: string,
	file: string,
	name: string,
	parser: ts.SourceFileParser,
	seen: Set<string>,
): ResolvedContract | undefined {
	const key = `${file}:${name}`;

	if (seen.has(key)) {
		return;
	}

	seen.add(key);
	const sourceFile = parseTypeScriptFile(join(cwd, file), parser);
	const declared = localTypeDeclaration(sourceFile, name);

	if (declared && localExportName(sourceFile, declared) === name) {
		return { file, node: declared, exportedName: name };
	}

	for (const statement of sourceFile.statements) {
		if (!ts.isExportDeclaration(statement)) {
			continue;
		}

		const target =
			statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
				? resolveImportFile(cwd, file, statement.moduleSpecifier.text)
				: undefined;

		if (!statement.exportClause) {
			const found = target && exportedType(cwd, target, name, parser, seen);

			if (found) {
				return found;
			}

			continue;
		}

		const specifier = ts.isNamedExports(statement.exportClause)
			? statement.exportClause.elements.find((item) => item.name.text === name)
			: undefined;

		if (!specifier) {
			continue;
		}

		const localName = specifier.propertyName?.text ?? specifier.name.text;

		if (target) {
			return exportedType(cwd, target, localName, parser, seen);
		}

		const local = localTypeDeclaration(sourceFile, localName);

		if (local) {
			return { file, node: local, exportedName: name };
		}

		const source = namedImportMap(cwd, file, sourceFile).get(localName);
		return source && exportedType(cwd, source.file, source.name, parser, seen);
	}

	return undefined;
}

function localTypeDeclaration(
	sourceFile: ts.SourceFile,
	name: string,
): ContractDeclaration | undefined {
	return sourceFile.statements.find(
		(statement): statement is ContractDeclaration =>
			(ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement))
			&& statement.name.text === name,
	);
}

/** The name a module exports a local declaration under, if any. */
function localExportName(
	sourceFile: ts.SourceFile,
	declaration: ContractDeclaration,
): string | undefined {
	if (declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
		return declaration.name.text;
	}

	for (const statement of sourceFile.statements) {
		if (
			ts.isExportDeclaration(statement)
			&& !statement.moduleSpecifier
			&& statement.exportClause
			&& ts.isNamedExports(statement.exportClause)
		) {
			const specifier = statement.exportClause.elements.find(
				(item) => (item.propertyName?.text ?? item.name.text) === declaration.name.text,
			);

			if (specifier) {
				return specifier.name.text;
			}
		}
	}
}

/** Reads a contract's service names, and what keeps them from being a fixed required set. */
function contractMembers(declaration: ContractDeclaration): {
	names: string[];
	problems: string[];
} {
	const names = new Set<string>();
	const problems: string[] = [];
	let members: readonly ts.TypeElement[];

	if (declaration.typeParameters?.length) {
		problems.push("declares type parameters");
	}

	if (ts.isInterfaceDeclaration(declaration)) {
		// Interfaces that share a name in one module merge, so the contract holds all their members.
		const merged = declaration
			.getSourceFile()
			.statements.filter(
				(statement): statement is ts.InterfaceDeclaration =>
					ts.isInterfaceDeclaration(statement) && statement.name.text === declaration.name.text,
			);

		if (merged.some((item) => item.heritageClauses?.length)) {
			problems.push("extends another type");
		}

		members = merged.flatMap((item) => item.members);
	} else if (ts.isTypeLiteralNode(declaration.type)) {
		members = declaration.type.members;
	} else {
		return { names: [], problems: [...problems, "is not an object type"] };
	}

	for (const member of members) {
		if (!ts.isPropertySignatureDeclaration(member) && !ts.isMethodSignatureDeclaration(member)) {
			problems.push(
				ts.isIndexSignatureDeclaration(member)
					? "has an index signature"
					: `has an unsupported member \`${member.getText()}\``,
			);
			continue;
		}

		const name = propertyName(member.name);

		if (name === undefined) {
			problems.push(`has a computed service name \`${member.name.getText()}\``);
		} else if (member.postfixToken?.kind === ts.SyntaxKind.QuestionToken) {
			problems.push(`declares service "${name}" optional`);
		} else {
			names.add(name);
		}
	}

	return { names: [...names], problems };
}

/**
 * The type reference generated metadata uses for a contract: a type-only import from
 * `.routa/routes.gen.ts`, so nothing executes when the metadata loads.
 */
export function contractTypeReference(services: ServiceContractMetadata): string {
	const file = services.file.split(sep).join("/").replace(/\.ts$/, ".js");
	return `import(${JSON.stringify(`../${file}`)}).${services.name}`;
}
