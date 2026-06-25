#!/usr/bin/env node

import { createProject } from "./create-project.js";

export function createCommandArgs(argv: readonly string[]): string[] {
	return ["create", ...argv];
}

export function runCreate(argv = process.argv.slice(2), cwd = process.cwd()): number {
	const [targetDir = "routa-app"] = argv;

	try {
		const result = createProject(targetDir, cwd);
		process.stdout.write(`Created Routa app at ${result.projectDir}\n`);
		return 0;
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
}

if (import.meta.url === `file://${process.argv[1]}`) {
	process.exitCode = runCreate();
}
