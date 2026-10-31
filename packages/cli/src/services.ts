import { existsSync } from "node:fs";
import { join, sep } from "node:path";
import { callName, objectLiteral, propertyName, resolveImportFile, unwrapExpression } from "./ast.js";
import { compareText } from "./contract-schemas.js";
import {
	boundDeclaration,
	type Diagnostic,
	namedImportMap,
	parseTypeScriptFile,
} from "./project.js";
import * as ts from "./typescript.js";

/** The application service contract `src/routa.ts` declares, read from source. */
export type ApplicationServicesMetadata = {
	/** The module that exports the contract, relative to the project root. */
	file: string;
	/** The name that module exports the contract under. */
	name: string;
	/** The contract's service names, sorted. */
	names: string[];
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
 * @returns The contract metadata when services are declared, and diagnostics for declarations
 *   Routa cannot read
 */
export function applicationServices(
	cwd: string,
	parser: ts.SourceFileParser,
): { services?: ApplicationServicesMetadata; diagnostics: Diagnostic[] } {
	if (!existsSync(join(cwd, configFile))) {
		return { diagnostics: [] };
	}

	const declaration = servicesDeclaration(parseTypeScriptFile(join(cwd, configFile), parser));

	if (!declaration) {
		return { diagnostics: [] };
	}

	const contract = ts.isExpression(declaration)
		? factoryContract(cwd, configFile, declaration, parser, 0)
		: undefined;

	if (!contract) {
		return {
			diagnostics: [
				{
					code: "ROUTA_SERVICES_UNRESOLVED",
					severity: "error",
					message: `Application services in ${configFile} cannot be statically resolved to a service contract.`,
					file: configFile,
					suggestion:
						"Declare `const defineAppServices = defineServices<AppServices>();` and set `services: defineAppServices(factory)`, or write `services: defineServices<AppServices>()(factory)`. Each binding must be a const declaration or a relative import.",
				},
			],
		};
	}

	return serviceContract(cwd, contract.file, contract.type, parser);
}

/** Finds the `services` member of the `createRouta({ ... })` call in `src/routa.ts`. */
function servicesDeclaration(sourceFile: ts.SourceFile): ts.Node | undefined {
	let declaration: ts.Node | undefined;

	const visit = (node: ts.Node): void => {
		if (declaration) {
			return;
		}

		if (ts.isCallExpression(node) && callName(node.expression) === "createRouta") {
			const config = objectLiteral(node.arguments[0]);
			const member = config?.properties.find(
				(property) =>
					!ts.isSpreadAssignment(property) && propertyName(property.name) === "services",
			);

			if (member) {
				declaration = ts.isPropertyAssignment(member)
					? member.initializer
					: ts.isShorthandPropertyAssignment(member)
						? member.name
						: member;
				return;
			}
		}

		ts.forEachChild(node, visit);
	};

	visit(sourceFile);
	return declaration;
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
): { services?: ApplicationServicesMetadata; diagnostics: Diagnostic[] } {
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
function contractMembers(declaration: ContractDeclaration): { names: string[]; problems: string[] } {
	const names = new Set<string>();
	const problems: string[] = [];
	let members: readonly ts.TypeElement[];

	if (declaration.typeParameters?.length) {
		problems.push("declares type parameters");
	}

	if (ts.isInterfaceDeclaration(declaration)) {
		if (declaration.heritageClauses?.length) {
			problems.push("extends another type");
		}

		members = declaration.members;
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
export function contractTypeReference(services: ApplicationServicesMetadata): string {
	const file = services.file.split(sep).join("/").replace(/\.ts$/, ".js");
	return `import(${JSON.stringify(`../${file}`)}).${services.name}`;
}
