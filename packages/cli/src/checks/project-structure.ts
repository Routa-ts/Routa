import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Diagnostic, ProjectModel } from "../project.js";

/**
 * Verifies that the required Routa project files and directories exist.
 *
 * @returns Diagnostics for each missing required project item.
 */
export function projectStructureDiagnostics({ cwd }: ProjectModel): Diagnostic[] {
	const required = [
		{ path: "package.json", message: "Missing package.json." },
		{ path: "tsconfig.json", message: "Missing tsconfig.json." },
		{ path: "src", message: "Missing src/ directory." },
		{ path: "src/routa.ts", message: "Missing src/routa.ts." },
	];

	return required
		.filter((item) => !existsSync(join(cwd, item.path)))
		.map((item) => ({
			code: "ROUTA_PROJECT_REQUIRED",
			severity: "error" as const,
			message: `${item.message} Routa commands must run inside a TypeScript Routa project.`,
			file: item.path,
			suggestion:
				"Create a project with pnpm create routa-ts@latest, or run this command at the project root.",
		}));
}
