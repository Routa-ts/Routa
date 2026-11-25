import { existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { parseTypeScriptFile } from "../declarations.js";
import type { Diagnostic, ProjectModel } from "../project.js";
import { routesRoot, walk } from "../route-discovery.js";
import * as ts from "../typescript.js";

/**
 * Reports duplicate schema export names in route schema files.
 *
 * @param cwd - Project root directory
 * @returns Diagnostics for repeated `export const` names in route `schemas.ts` files under `src/routes`
 */
export function duplicateSchemaDiagnostics({ cwd, parser }: ProjectModel): Diagnostic[] {
	const routesDir = join(cwd, routesRoot);

	if (!existsSync(routesDir)) {
		return [];
	}

	const diagnostics: Diagnostic[] = [];

	for (const file of walk(routesDir).filter((item) => item.endsWith(`${sep}schemas.ts`))) {
		const relativeFile = relative(cwd, file);
		const sourceFile = parseTypeScriptFile(file, parser);
		const seen = new Set<string>();

		for (const statement of sourceFile.statements) {
			if (!ts.isVariableStatement(statement)) {
				continue;
			}

			if (!statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
				continue;
			}

			if (!(statement.declarationList.flags & ts.NodeFlags.Const)) {
				continue;
			}

			for (const declaration of statement.declarationList.declarations) {
				if (!ts.isIdentifier(declaration.name)) {
					continue;
				}

				const name = declaration.name.text;

				if (seen.has(name)) {
					diagnostics.push({
						code: "ROUTA_DUPLICATE_SCHEMA_NAME",
						severity: "error",
						message: `Duplicate schema export ${name}.`,
						file: relativeFile,
						suggestion: "Use a stable contract-purpose name such as CreateUserResponse.",
					});
					continue;
				}

				seen.add(name);
			}
		}
	}

	return diagnostics;
}
