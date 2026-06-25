#!/usr/bin/env node

import { runOpenApiBreaking, runOpenApiCheck } from "./openapi.js";
import { runProjectBuild, runProjectCheck } from "./project.js";
import { scaffoldOpenApi } from "./scaffold.js";

export type CommandResult = {
	code: number;
	stdout?: string;
	stderr?: string;
};

const helpText = `Routa

Usage:
  routa create [dir]
  routa scaffold <openapi.yaml|openapi.json>
  routa check
  routa build
  routa openapi check
  routa openapi breaking [--update-baseline]
`;

const notImplementedCode = 2;

export type RunOptions = {
	cwd?: string;
};

export function run(argv: readonly string[], options: RunOptions = {}): CommandResult {
	const [command, subcommand] = argv;
	const cwd = options.cwd ?? process.cwd();

	if (!command || command === "--help" || command === "-h") {
		return { code: 0, stdout: helpText };
	}

	if (command === "create") {
		return { code: notImplementedCode, stderr: "Routa project creation is not implemented yet.\n" };
	}

	if (command === "scaffold") {
		if (!subcommand) {
			return { code: 1, stderr: "Missing OpenAPI input file.\n" };
		}

		try {
			const result = scaffoldOpenApi(subcommand, cwd, {
				preview: argv.includes("--preview"),
				yes: argv.includes("--yes"),
			});
			return {
				code: 0,
				stdout: `${result.preview ? "Previewed" : "Scaffolded"} ${result.routes.length} Routa route file(s).\n${result.files.join("\n")}\n`,
			};
		} catch (error) {
			return { code: 1, stderr: `${error instanceof Error ? error.message : String(error)}\n` };
		}
	}

	if (command === "check") {
		return runProjectCheck(cwd);
	}

	if (command === "build") {
		return runProjectBuild(cwd);
	}

	if (command === "openapi" && (subcommand === "check" || subcommand === "breaking")) {
		return subcommand === "check" ? runOpenApiCheck(cwd) : runOpenApiBreaking(argv.slice(2), cwd);
	}

	return { code: 1, stderr: `Unknown command: ${command}\n\n${helpText}` };
}

export function main(argv = process.argv.slice(2)): void {
	const result = run(argv);

	if (result.stdout) {
		process.stdout.write(result.stdout);
	}

	if (result.stderr) {
		process.stderr.write(result.stderr);
	}

	process.exitCode = result.code;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	main();
}
