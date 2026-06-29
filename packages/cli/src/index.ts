#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createProject, resolveRoutaVersion } from "create-routa";
import { runOpenApiBreaking, runOpenApiCheck } from "./openapi.js";
import {
	runProjectBuild,
	runProjectCheck,
	runProjectDev,
	runProjectDevProcess,
	runProjectStart,
} from "./project.js";
import type { ScaffoldPreviewChange } from "./scaffold.js";
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
  routa dev
  routa start
  routa check
  routa build
  routa openapi check
  routa openapi breaking [--update-baseline]
`;

export type RunOptions = {
	cwd?: string;
};

/**
 * Dispatches a Routa CLI command.
 *
 * @param argv - Command-line arguments after the executable name
 * @param options - Command options
 * @returns The command result, including an exit code and optional output
 */
export function run(argv: readonly string[], options: RunOptions = {}): CommandResult {
	const [command, subcommand] = argv;
	const cwd = options.cwd ?? process.cwd();

	if (!command || command === "--help" || command === "-h") {
		return { code: 0, stdout: helpText };
	}

	if (command === "create") {
		return runCreateCommand(argv.slice(1), cwd);
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
				stdout: formatScaffoldResult(result),
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

	if (command === "dev") {
		return runProjectDev(argv.slice(1), cwd);
	}

	if (command === "start") {
		return runProjectStart(argv.slice(1), cwd);
	}

	if (command === "openapi" && (subcommand === "check" || subcommand === "breaking")) {
		return subcommand === "check" ? runOpenApiCheck(cwd) : runOpenApiBreaking(argv.slice(2), cwd);
	}

	return { code: 1, stderr: `Unknown command: ${command}\n\n${helpText}` };
}

/**
 * Creates a Routa project in the target directory and formats the CLI result.
 *
 * @param argv - Command-line arguments after `create`
 * @param cwd - Base working directory for project creation
 * @returns The command exit code and any output or error text
 */
function runCreateCommand(argv: readonly string[], cwd: string): CommandResult {
	const targetDir = argv.find((item) => !item.startsWith("--")) ?? "routa-app";

	try {
		const result = createProject(targetDir, cwd, {
			openApi: !argv.includes("--no-openapi"),
			routaVersion: resolveRoutaVersion(cwd, targetDir),
		});
		let stdout = createSummary(targetDir, result.files);
		let stderr = "";

		if (argv.includes("--git")) {
			const git = spawnSync("git", ["init"], {
				cwd: result.projectDir,
				encoding: "utf8",
			});

			if (git.status === 0) {
				stdout += "Initialized git repository.\n";
			} else {
				stderr += `git init failed. ${git.stderr ?? ""}\n`;
			}
		}

		if (argv.includes("--install")) {
			const install = spawnSync("pnpm", ["install"], {
				cwd: result.projectDir,
				encoding: "utf8",
			});

			if (install.status !== 0) {
				stderr +=
					'Command "pnpm install" did not run successfully. Please run this manually in your project.\n';
				stderr += install.stderr ?? "";
			} else {
				stdout += install.stdout ?? "";
			}
		}

		stdout += `\nYour Routa app is ready in '${targetDir}'.\n\n`;
		stdout += "Use the following commands to start your app:\n";
		stdout += `cd ${targetDir}\n`;

		if (!argv.includes("--install")) {
			stdout += "pnpm install\n";
		}

		stdout += "pnpm dev\n";

		return { code: 0, stdout, stderr: stderr || undefined };
	} catch (error) {
		return { code: 1, stderr: `${error instanceof Error ? error.message : String(error)}\n` };
	}
}

/**
 * Formats a summary of the created project files.
 *
 * @param targetDir - The project directory name
 * @param files - The created file paths
 * @returns A summary string listing the created files
 */
function createSummary(targetDir: string, files: string[]): string {
	return `Created Routa project '${targetDir}' with ${files.length} file(s).\n${files.join("\n")}\n`;
}

/**
 * Formats scaffold output for display in the CLI.
 *
 * @param result - The scaffold result to format
 * @returns The formatted output text
 */
function formatScaffoldResult(result: ReturnType<typeof scaffoldOpenApi>): string {
	const lines = [
		`${result.preview ? "Previewed" : "Scaffolded"} ${result.routes.length} Routa route file(s).`,
		...result.files,
	];

	if (result.preview && result.changes.length > 0) {
		lines.push("", "Preview diff:");

		for (const change of result.changes) {
			lines.push(
				`${previewMarker(change.status)} ${change.path}${change.detail ? ` (${change.detail})` : ""}`,
			);

			if (change.diff) {
				lines.push(...change.diff.map((line) => `  ${line}`));
			}
		}
	}

	return `${lines.join("\n")}\n`;
}

/**
 * Maps a scaffold preview status to its display marker.
 *
 * @param status - The preview change status.
 * @returns The marker string for the given status.
 */
function previewMarker(status: ScaffoldPreviewChange["status"]): string {
	switch (status) {
		case "add":
			return "+ add";
		case "update":
			return "~ update";
		case "unchanged":
			return "= unchanged";
		case "conflict":
			return "! conflict";
		case "remove":
			return "- remove";
	}
}

/**
 * Runs the CLI command and writes its output to the process streams.
 *
 * @param argv - Command-line arguments to process
 */
export function main(argv = process.argv.slice(2)): void {
	if (argv[0] === "dev") {
		runProjectDevProcess(argv.slice(1));
		return;
	}

	const result = run(argv);

	if (result.stdout) {
		process.stdout.write(result.stdout);
	}

	if (result.stderr) {
		process.stderr.write(result.stderr);
	}

	process.exitCode = result.code;
}

if (isCliEntry()) {
	main();
}

/**
 * Determines whether this module is running as the CLI entrypoint.
 *
 * @returns `true` if the current process was started through this file, `false` otherwise.
 */
function isCliEntry(): boolean {
	if (!process.argv[1]) {
		return false;
	}

	try {
		return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
	} catch {
		return false;
	}
}
