import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, extname, join, relative, resolve, sep } from "node:path";
import {
	createScaffoldPlan,
	evaluateScaffold,
	type Manifest,
	type ScaffoldEvaluation,
	type ScaffoldPlan,
	type ScaffoldPreviewChange,
	type ScaffoldRoute,
	type ScaffoldSnapshot,
} from "./scaffold-plan.js";

export type { ScaffoldPreviewChange } from "./scaffold-plan.js";

export type ScaffoldResult = {
	files: string[];
	changes: ScaffoldPreviewChange[];
	routes: ScaffoldRoute[];
	preview: boolean;
};
export type ScaffoldOptions = { preview?: boolean; yes?: boolean };

export function scaffoldOpenApi(
	inputFile: string,
	cwd = process.cwd(),
	options: ScaffoldOptions = {},
): ScaffoldResult {
	assertTypeScriptProject(cwd);

	const extension = extname(inputFile).toLowerCase();

	if (![".yaml", ".yml", ".json"].includes(extension)) {
		throw new Error(
			scaffoldError(
				"ROUTA_OPENAPI_UNSUPPORTED_EXTENSION",
				`Unsupported OpenAPI input "${inputFile}".`,
				[
					"Routa v0 scaffold accepts .yaml, .yml, and .json files.",
					"Example: routa scaffold openapi.yaml",
				],
			),
		);
	}

	const absoluteInput = resolve(cwd, inputFile);
	const source = relative(cwd, absoluteInput);

	if (!existsSync(absoluteInput)) {
		throw new Error(
			scaffoldError("ROUTA_OPENAPI_FILE_NOT_FOUND", `Could not find ${source}.`, [
				"Run this command from the project root or pass the correct OpenAPI file path.",
				"Example: routa scaffold openapi.yaml",
			]),
		);
	}

	const raw = readFileSync(absoluteInput, "utf8");
	const plan = createScaffoldPlan(raw, extension, source);
	const snapshot = readScaffoldSnapshot(cwd, plan);
	const evaluation = evaluateScaffold(plan, snapshot);

	if (options.preview) {
		return {
			files: plan.fileList,
			changes: evaluation.changes,
			routes: plan.routes,
			preview: true,
		};
	}

	if (snapshot.manifest && !options.yes) {
		throw new Error(
			"Regeneration requires preview or confirmation. Re-run with --preview or --yes.",
		);
	}

	if (evaluation.blocked) {
		throw new Error(evaluation.blocked);
	}

	applyScaffoldPlan(cwd, plan, snapshot, evaluation);

	return {
		files: plan.fileList,
		changes: evaluation.changes,
		routes: plan.routes,
		preview: false,
	};
}

function assertTypeScriptProject(cwd: string): void {
	const missing = ["package.json", "tsconfig.json", "src"].filter(
		(path) => !existsSync(join(cwd, path)),
	);

	if (missing.length > 0) {
		throw new Error(
			`ROUTA_PROJECT_REQUIRED: routa scaffold must run inside a TypeScript Routa project. Missing ${missing.join(", ")}.`,
		);
	}
}

function writeFile(filePath: string, content: string): void {
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, content);
}

function resolveInsideProject(cwd: string, path: string): string {
	const projectRoot = resolve(cwd);
	const absolutePath = resolve(projectRoot, path);

	if (absolutePath !== projectRoot && !absolutePath.startsWith(`${projectRoot}${sep}`)) {
		throw new Error(
			scaffoldError(
				"ROUTA_SCAFFOLD_PATH_OUTSIDE_PROJECT",
				`Refusing to touch ${path} outside the project root.`,
				["Generated files must stay inside the project directory."],
			),
		);
	}

	return absolutePath;
}

function readManifest(cwd: string): Manifest | undefined {
	const file = join(cwd, ".routa/manifest.json");

	if (!existsSync(file)) {
		return undefined;
	}

	try {
		return JSON.parse(readFileSync(file, "utf8")) as Manifest;
	} catch (error) {
		throw new Error(
			scaffoldError(
				"ROUTA_MANIFEST_INVALID",
				`Could not parse .routa/manifest.json: ${error instanceof Error ? error.message : String(error)}`,
				[
					"Fix the JSON syntax, or restore the file from version control.",
					"Deleting the manifest makes the next scaffold treat all generated files as new.",
				],
			),
		);
	}
}

function readScaffoldSnapshot(cwd: string, plan: ScaffoldPlan): ScaffoldSnapshot {
	const manifest = readManifest(cwd);
	const paths = new Set([
		...plan.files.keys(),
		".routa/manifest.json",
		...(manifest?.generated.map((file) => file.path) ?? []),
	]);
	const files = new Map<string, string | undefined>();

	for (const path of paths) {
		const absolutePath = resolveInsideProject(cwd, path);
		files.set(path, existsSync(absolutePath) ? readFileSync(absolutePath, "utf8") : undefined);
	}

	return { manifest, files };
}

function applyScaffoldPlan(
	cwd: string,
	plan: ScaffoldPlan,
	snapshot: ScaffoldSnapshot,
	evaluation: ScaffoldEvaluation,
): void {
	if (evaluation.blocked) {
		throw new Error(evaluation.blocked);
	}

	mkdirSync(join(cwd, ".routa"), { recursive: true });

	for (const path of evaluation.stalePaths) {
		if (snapshot.files.get(path) !== undefined) {
			unlinkSync(resolveInsideProject(cwd, path));
		}
	}

	for (const [path, content] of plan.files) {
		writeFile(resolveInsideProject(cwd, path), content);
	}

	writeFile(resolveInsideProject(cwd, ".routa/manifest.json"), plan.manifestContent);
}

function scaffoldError(code: string, message: string, details: string[] = []): string {
	return [`${code}: ${message}`, ...details].join("\n");
}
