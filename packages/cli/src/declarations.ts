import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveImportFile } from "./ast.js";
import * as ts from "./typescript.js";

/**
 * Reads what a declaration's initializer declares, such as the object it passes to its factory,
 * or `undefined` when the declaration is not the kind being looked for. `file` is the module the
 * initializer is written in, relative to the project root.
 */
export type DeclarationReader<T> = (expression: ts.Expression, file: string) => T | undefined;

export type ModuleDeclaration<T = ts.ObjectLiteralExpression> = {
	/** The file that declares the value. */
	file: string;
	/** The declared variable name in `file`. */
	name: string;
	/** The name the inspected module exports it under. */
	exportedName: string;
	/** What the reader read from the declaration. */
	contract: T;
};

/**
 * A name a module exports, and the node that gives its value where Routa can follow it: a
 * variable's initializer, or the function, class, enum, interface, or type declaration itself.
 */
export type ModuleExport = {
	/** The file that declares the value, or the module whose export Routa could not follow. */
	file: string;
	/** The declared name in `file`. */
	name: string;
	/** The name the inspected module exports it under. */
	exportedName: string;
	/**
	 * Missing when Routa cannot follow the export: a destructured or uninitialized binding, a
	 * re-export from a package, or a name the target module does not export in a form it reads.
	 */
	value?: ts.Node;
	/** For a destructured or uninitialized binding, the declaration it comes from. */
	from?: ts.VariableDeclaration;
};

/**
 * Lists every named export of a module, following its re-exports: `export const`, exported
 * function, class, enum, interface, and type declarations, names exported later with
 * `export { name }`, named re-exports (aliases included), and `export *`. Type-only exports and
 * `export default` statements are left out.
 *
 * Each branch of the walk carries its own copy of the visited files, so a cycle ends the branch
 * that closes it while sibling re-exports of the same module still resolve.
 *
 * @param cwd - The project root directory
 * @param file - The module being inspected
 * @param sourceFile - The parsed TypeScript source file for `file`
 * @returns The exports in declaration order, explicit exports before wildcard ones
 */
export function moduleExports(
	cwd: string,
	file: string,
	sourceFile: ts.SourceFile,
	parser: ts.SourceFileParser,
	seen = new Set<string>(),
): ModuleExport[] {
	if (seen.has(file)) {
		return [];
	}

	seen.add(file);

	const explicit: ModuleExport[] = [];
	const wildcard: ModuleExport[] = [];
	const walk = (target: string) =>
		moduleExports(
			cwd,
			target,
			parseTypeScriptFile(join(cwd, target), parser),
			parser,
			new Set(seen),
		);
	const reexport = (target: string | undefined, name: string, exportedName: string) => {
		const found = target && walk(target).find((item) => item.exportedName === name);
		return found ? { ...found, exportedName } : { file, name, exportedName };
	};

	for (const statement of sourceFile.statements) {
		if (ts.isVariableStatement(statement)) {
			if (hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
				for (const declaration of statement.declarationList.declarations) {
					for (const binding of variableBindings(file, declaration)) {
						explicit.push({ ...binding, exportedName: binding.name });
					}
				}
			}
			continue;
		}

		if (
			isValueDeclaration(statement)
			&& hasModifier(statement, ts.SyntaxKind.ExportKeyword)
			&& !hasModifier(statement, ts.SyntaxKind.DefaultKeyword)
		) {
			const name = statement.name!.text;
			explicit.push({ file, name, exportedName: name, value: statement });
			continue;
		}

		if (!ts.isExportDeclaration(statement) || statement.isTypeOnly) {
			continue;
		}

		const specifier =
			statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
				? statement.moduleSpecifier.text
				: undefined;
		const target = specifier === undefined ? undefined : resolveImportFile(cwd, file, specifier);

		if (!statement.exportClause) {
			if (target) {
				wildcard.push(...walk(target).filter((item) => item.exportedName !== "default"));
			}
			continue;
		}

		if (!ts.isNamedExports(statement.exportClause)) {
			continue;
		}

		for (const element of statement.exportClause.elements) {
			if (element.isTypeOnly) {
				continue;
			}

			const exportedName = element.name.text;
			const name = element.propertyName?.text ?? exportedName;

			if (specifier !== undefined) {
				explicit.push(reexport(target, name, exportedName));
				continue;
			}

			const local = localBinding(cwd, file, sourceFile, name, parser, seen);

			if (local !== "none") {
				explicit.push({ ...local, exportedName });
			}
		}
	}

	const exportedNames = new Set(explicit.map((item) => item.exportedName));
	return [
		...explicit,
		...wildcard.filter((item) => {
			if (exportedNames.has(item.exportedName)) {
				return false;
			}
			exportedNames.add(item.exportedName);
			return true;
		}),
	];
}

/**
 * What a module binds to a top-level name: its own declaration, or the export an import names.
 * Returns `none` for a name that holds no value Routa follows, a namespace or type-only import,
 * and an entry without `value` when Routa cannot follow the binding.
 *
 * @param file - The module that uses the name, relative to `cwd`
 * @param name - The local name in `file`
 */
export function localBinding(
	cwd: string,
	file: string,
	sourceFile: ts.SourceFile,
	name: string,
	parser: ts.SourceFileParser,
	seen = new Set<string>(),
): Omit<ModuleExport, "exportedName"> | "none" {
	for (const statement of sourceFile.statements) {
		if (ts.isVariableStatement(statement)) {
			for (const declaration of statement.declarationList.declarations) {
				const binding = variableBindings(file, declaration).find((item) => item.name === name);

				if (binding) {
					return binding;
				}
			}
			continue;
		}

		if (isValueDeclaration(statement) && statement.name?.text === name) {
			return { file, name, value: statement };
		}

		if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) {
			continue;
		}

		const clause = statement.importClause;
		const target = resolveImportFile(cwd, file, statement.moduleSpecifier.text);
		const bindings = clause?.namedBindings;

		if (bindings && ts.isNamespaceImport(bindings) && bindings.name.text === name) {
			return "none";
		}

		const imported =
			bindings && ts.isNamedImports(bindings)
				? bindings.elements.find((element) => element.name.text === name)
				: undefined;
		const importedName =
			clause?.name?.text === name
				? "default"
				: (imported?.propertyName?.text ?? imported?.name.text);

		if (importedName === undefined) {
			continue;
		}

		if (clause?.phaseModifier === ts.SyntaxKind.TypeKeyword || imported?.isTypeOnly) {
			return "none";
		}

		const found =
			target
			&& moduleExports(
				cwd,
				target,
				parseTypeScriptFile(join(cwd, target), parser),
				parser,
				new Set(seen),
			).find((item) => item.exportedName === importedName);
		return found || { file, name };
	}

	return { file, name };
}

/**
 * Resolves exported declarations from a module and its re-exports, as {@link moduleExports}
 * lists them, keeping the variables whose initializer `read` reads.
 *
 * @param cwd - The project root directory
 * @param file - The module being inspected
 * @param sourceFile - The parsed TypeScript source file for `file`
 * @returns Declarations found in the module graph, explicit exports before wildcard ones
 */
export function exportedDeclarations<T>(
	cwd: string,
	file: string,
	sourceFile: ts.SourceFile,
	parser: ts.SourceFileParser,
	read: DeclarationReader<T>,
): ModuleDeclaration<T>[] {
	return moduleExports(cwd, file, sourceFile, parser).flatMap((item) => {
		const contract =
			item.value && ts.isExpression(item.value) ? read(item.value, item.file) : undefined;
		return contract
			? [{ file: item.file, name: item.name, exportedName: item.exportedName, contract }]
			: [];
	});
}

/** The names a variable declaration binds, each with its initializer when it binds a plain name. */
function variableBindings(
	file: string,
	declaration: ts.VariableDeclaration,
): Array<Omit<ModuleExport, "exportedName">> {
	if (ts.isIdentifier(declaration.name)) {
		const name = declaration.name.text;
		return [
			declaration.initializer
				? { file, name, value: declaration.initializer }
				: { file, name, from: declaration },
		];
	}

	const names: string[] = [];
	const visit = (node: ts.Node): void => {
		if (ts.isBindingElement(node) && node.name && ts.isIdentifier(node.name)) {
			names.push(node.name.text);
		}
		ts.forEachChild(node, visit);
	};
	visit(declaration.name);
	return names.map((name) => ({ file, name, from: declaration }));
}

/** A top-level declaration whose name holds a value or type rather than a variable's. */
function isValueDeclaration(
	statement: ts.Statement,
): statement is
	| ts.FunctionDeclaration
	| ts.ClassDeclaration
	| ts.EnumDeclaration
	| ts.InterfaceDeclaration
	| ts.TypeAliasDeclaration {
	return (
		(ts.isFunctionDeclaration(statement)
			|| ts.isClassDeclaration(statement)
			|| ts.isEnumDeclaration(statement)
			|| ts.isInterfaceDeclaration(statement)
			|| ts.isTypeAliasDeclaration(statement))
		&& statement.name !== undefined
	);
}

/**
 * Maps named imports to their source module and exported name.
 *
 * @param cwd - The project root directory.
 * @param file - The file containing the import declarations.
 * @param sourceFile - The parsed TypeScript source file.
 * @returns A map from local import names to the resolved module file and imported name.
 */
export function namedImportMap(
	cwd: string,
	file: string,
	sourceFile: ts.SourceFile,
): Map<string, { file: string; name: string }> {
	const imports = new Map<string, { file: string; name: string }>();

	for (const statement of sourceFile.statements) {
		if (
			!ts.isImportDeclaration(statement)
			|| !ts.isStringLiteral(statement.moduleSpecifier)
			|| !statement.importClause?.namedBindings
			|| !ts.isNamedImports(statement.importClause.namedBindings)
		) {
			continue;
		}

		const sourceFile = resolveImportFile(cwd, file, statement.moduleSpecifier.text);

		if (!sourceFile) {
			continue;
		}

		for (const specifier of statement.importClause.namedBindings.elements) {
			imports.set(specifier.name.text, {
				file: sourceFile,
				name: specifier.propertyName?.text ?? specifier.name.text,
			});
		}
	}

	return imports;
}

/**
 * Resolves an imported binding to the declaration that defines it, following re-export chains
 * and aliases.
 *
 * @param source - The imported module and the name it exports the value under
 * @param read - Reads the declarations that count, such as `createMiddleware` calls
 * @returns The declaring file, declared name, and what `read` read, or `undefined` when unresolved
 */
export function exportedDeclaration<T>(
	cwd: string,
	source: { file: string; name: string },
	parser: ts.SourceFileParser,
	read: DeclarationReader<T>,
): ModuleDeclaration<T> | undefined {
	const targetAst = parseTypeScriptFile(join(cwd, source.file), parser);
	return exportedDeclarations(cwd, source.file, targetAst, parser, read).find(
		(item) => item.exportedName === source.name,
	);
}

/**
 * Finds the `const` declaration a module binds to a name, whether the module declares it or
 * imports it, and reads it. Imports follow relative modules and re-export chains.
 *
 * @param file - The module that uses the name, relative to `cwd`
 * @param name - The local name in `file`
 * @returns The declaring file, declared name, and what `read` read, or `undefined`
 */
export function boundDeclaration<T>(
	cwd: string,
	file: string,
	name: string,
	parser: ts.SourceFileParser,
	read: DeclarationReader<T>,
): ModuleDeclaration<T> | undefined {
	const sourceFile = parseTypeScriptFile(join(cwd, file), parser);
	const local = variableDeclarations(file, sourceFile, false, read).find(
		(item) => item.name === name,
	);

	if (local) {
		return { file, name, exportedName: name, contract: local.contract };
	}

	const source = namedImportMap(cwd, file, sourceFile).get(name);
	return source && exportedDeclaration(cwd, source, parser, read);
}

/**
 * Parses a TypeScript source file.
 *
 * @param file - The file path to read and parse.
 * @returns The parsed TypeScript source file.
 */
export function parseTypeScriptFile(file: string, parser: ts.SourceFileParser): ts.SourceFile {
	return parser.createSourceFile(file, readFileSync(file, "utf8"));
}

/**
 * Collects a source file's declarations that `read` accepts, such as `createMiddleware` calls.
 *
 * @param file - The source file's path relative to the project root, passed to `read`.
 * @param sourceFile - The TypeScript source file to inspect.
 * @param exportedOnly - Whether to include only exported variable declarations.
 * @returns The declared names and what `read` read from each.
 */
export function variableDeclarations<T>(
	file: string,
	sourceFile: ts.SourceFile,
	exportedOnly: boolean,
	read: DeclarationReader<T>,
): Array<{ name: string; contract: T }> {
	const declarations: Array<{ name: string; contract: T }> = [];

	for (const statement of sourceFile.statements) {
		if (!ts.isVariableStatement(statement)) {
			continue;
		}

		if (exportedOnly && !hasModifier(statement, ts.SyntaxKind.ExportKeyword)) {
			continue;
		}

		for (const declaration of statement.declarationList.declarations) {
			if (!ts.isIdentifier(declaration.name) || !declaration.initializer) {
				continue;
			}

			const contract = read(declaration.initializer, file);

			if (!contract) {
				continue;
			}

			declarations.push({ name: declaration.name.text, contract });
		}
	}

	return declarations;
}

/** Whether a statement carries a modifier, such as `export`. */
function hasModifier(
	statement: ts.Statement & { readonly modifiers?: ts.NodeArray<ts.ModifierLike> },
	kind: ts.SyntaxKind,
): boolean {
	return statement.modifiers?.some((modifier) => modifier.kind === kind) ?? false;
}
