import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveImportFile } from "./ast.js";
import * as ts from "./typescript.js";

/**
 * Reads what a declaration's initializer declares, such as the object it passes to its factory,
 * or `undefined` when the declaration is not the kind being looked for.
 */
export type DeclarationReader<T> = (expression: ts.Expression) => T | undefined;

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
 * Resolves exported declarations from a module and its re-exports: `export const`, names exported
 * later with `export { name }`, named re-exports (aliases included), and `export *`.
 *
 * Each branch of the walk carries its own copy of the visited files, so a cycle ends the branch
 * that closes it while sibling re-exports of the same module still resolve.
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
	seen = new Set<string>(),
): ModuleDeclaration<T>[] {
	if (seen.has(file)) {
		return [];
	}

	seen.add(file);

	const declarations: ModuleDeclaration<T>[] = [];
	const wildcard: ModuleDeclaration<T>[] = [];
	const imports = namedImportMap(cwd, file, sourceFile);
	const walk = (target: string) =>
		exportedDeclarations(
			cwd,
			target,
			parseTypeScriptFile(join(cwd, target), parser),
			parser,
			read,
			new Set(seen),
		);

	for (const statement of sourceFile.statements) {
		if (ts.isVariableStatement(statement) && hasExportModifier(statement)) {
			for (const declaration of statement.declarationList.declarations) {
				if (!ts.isIdentifier(declaration.name) || !declaration.initializer) {
					continue;
				}

				const contract = read(declaration.initializer);

				if (contract) {
					const name = declaration.name.text;
					declarations.push({ file, name, exportedName: name, contract });
				}
			}
			continue;
		}

		if (!ts.isExportDeclaration(statement)) {
			continue;
		}

		const targetFile =
			statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
				? resolveImportFile(cwd, file, statement.moduleSpecifier.text)
				: undefined;

		if (!statement.exportClause) {
			if (targetFile) {
				wildcard.push(...walk(targetFile));
			}
			continue;
		}

		if (!ts.isNamedExports(statement.exportClause)) {
			continue;
		}

		for (const specifier of statement.exportClause.elements) {
			const exportedName = specifier.name.text;
			const importedName = specifier.propertyName?.text ?? specifier.name.text;

			if (!statement.moduleSpecifier) {
				const local = variableDeclarations(sourceFile, false, read).find(
					(item) => item.name === importedName,
				);

				if (local) {
					declarations.push({ file, name: importedName, exportedName, contract: local.contract });
					continue;
				}
			}

			const source = targetFile
				? { file: targetFile, name: importedName }
				: imports.get(importedName);

			if (!source) {
				continue;
			}

			const declaration = walk(source.file).find((item) => item.exportedName === source.name);

			if (declaration) {
				declarations.push({ ...declaration, exportedName });
			}
		}
	}

	const exportedNames = new Set(declarations.map((item) => item.exportedName));
	return [
		...declarations,
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
	const local = variableDeclarations(sourceFile, false, read).find((item) => item.name === name);

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
 * @param sourceFile - The TypeScript source file to inspect.
 * @param exportedOnly - Whether to include only exported variable declarations.
 * @returns The declared names and what `read` read from each.
 */
export function variableDeclarations<T>(
	sourceFile: ts.SourceFile,
	exportedOnly: boolean,
	read: DeclarationReader<T>,
): Array<{ name: string; contract: T }> {
	const declarations: Array<{ name: string; contract: T }> = [];

	for (const statement of sourceFile.statements) {
		if (!ts.isVariableStatement(statement)) {
			continue;
		}

		if (exportedOnly && !hasExportModifier(statement)) {
			continue;
		}

		for (const declaration of statement.declarationList.declarations) {
			if (!ts.isIdentifier(declaration.name) || !declaration.initializer) {
				continue;
			}

			const contract = read(declaration.initializer);

			if (!contract) {
				continue;
			}

			declarations.push({ name: declaration.name.text, contract });
		}
	}

	return declarations;
}

/**
 * Determines whether a variable statement is exported.
 *
 * @returns `true` if the statement has an `export` modifier, `false` otherwise.
 */
function hasExportModifier(statement: ts.VariableStatement): boolean {
	return (
		statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false
	);
}
