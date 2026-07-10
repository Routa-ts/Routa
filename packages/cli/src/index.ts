#!/usr/bin/env node

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runCreate } from "create-routa-ts";
import { runOpenApiBreaking, runOpenApiCheck } from "./openapi.js";
import {
	runProjectBuild,
	runProjectCheck,
	runProjectDev,
	runProjectDevProcess,
	runProjectGenerate,
	runProjectRoutes,
	runProjectStart,
} from "./project.js";
import type { ScaffoldPreviewChange } from "./scaffold.js";
import { scaffoldOpenApi } from "./scaffold.js";
import { createUi, shouldUseColor, type Ui } from "./ui.js";

export type CommandResult = {
	code: number;
	stdout?: string;
	stderr?: string;
};

function helpText(ui: Ui): string {
	return `${ui.heading("Routa")}

${ui.muted("Usage:")}
  ${ui.command("routa create [dir]")}
  ${ui.command("routa scaffold <openapi.yaml|openapi.json>")}
  ${ui.command("routa dev")}
  ${ui.command("routa start")}
  ${ui.command("routa check")}
  ${ui.command("routa generate")}
  ${ui.command("routa build")}
  ${ui.command("routa routes [--format json|markdown]")}
  ${ui.command("routa openapi check")}
  ${ui.command("routa openapi breaking [--update-baseline]")}
`;
}

export type RunOptions = {
	cwd?: string;
	color?: boolean;
};

/**
 * Dispatches a Routa CLI command.
 *
 * `create` is async and shares `runCreate` with `main()` so project side-effects match.
 * `dev` stays on the sync `runProjectDev` path for programmatic callers and tests
 * (for example `--print`); the real CLI entrypoint uses `runProjectDevProcess` instead.
 *
 * @param argv - Command-line arguments after the executable name
 * @param options - Command options
 * @returns The command result, including an exit code and optional output
 */
export function run(
	argv: readonly string[],
	options: RunOptions = {},
): CommandResult | Promise<CommandResult> {
	const [command, subcommand] = argv;
	const cwd = options.cwd ?? process.cwd();
	const ui = createUi(options.color ?? false);

	if (!command || command === "--help" || command === "-h") {
		return { code: 0, stdout: helpText(ui) };
	}

	if (command === "create") {
		return runCreateCommand(argv.slice(1), cwd);
	}

	if (command === "scaffold") {
		const inputFile = argv.slice(1).find((item) => !item.startsWith("-"));

		if (!inputFile) {
			return { code: 1, stderr: `${ui.error("Error:")} Missing OpenAPI input file.\n` };
		}

		try {
			const result = scaffoldOpenApi(inputFile, cwd, {
				preview: argv.includes("--preview"),
				yes: argv.includes("--yes"),
			});
			return {
				code: 0,
				stdout: formatScaffoldResult(result, ui),
			};
		} catch (error) {
			return {
				code: 1,
				stderr: `${ui.error("Error:")} ${error instanceof Error ? error.message : String(error)}\n`,
			};
		}
	}

	if (command === "check") {
		return runProjectCheck(cwd);
	}

	if (command === "generate") {
		return runProjectGenerate(cwd);
	}

	if (command === "build") {
		return runProjectBuild(cwd);
	}

	if (command === "routes") {
		return runProjectRoutes(argv.slice(1), cwd);
	}

	if (command === "dev") {
		// Programmatic/sync path for tests (`--print`, etc.). `main()` uses runProjectDevProcess.
		return runProjectDev(argv.slice(1), cwd);
	}

	if (command === "start") {
		return runProjectStart(argv.slice(1), cwd);
	}

	if (command === "openapi" && (subcommand === "check" || subcommand === "breaking")) {
		try {
			return subcommand === "check" ? runOpenApiCheck(cwd) : runOpenApiBreaking(argv.slice(2), cwd);
		} catch (error) {
			return {
				code: 1,
				stderr: `${ui.error("Error:")} ${error instanceof Error ? error.message : String(error)}\n`,
			};
		}
	}

	return {
		code: 1,
		stderr: `${ui.error("Error:")} Unknown command: ${command}\n\n${helpText(ui)}`,
	};
}

/**
 * Creates a Routa project through the shared `runCreate` entrypoint used by `main()`.
 *
 * Captures process output so programmatic callers still receive a `CommandResult`.
 *
 * @param argv - Command-line arguments after `create`
 * @param cwd - Base working directory for project creation
 * @returns The command exit code and captured output
 */
async function runCreateCommand(argv: readonly string[], cwd: string): Promise<CommandResult> {
	let stdout = "";
	let stderr = "";
	const originalStdoutWrite = process.stdout.write;
	const originalStderrWrite = process.stderr.write;

	process.stdout.write = ((chunk: string | Uint8Array) => {
		stdout += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		return true;
	}) as typeof process.stdout.write;

	process.stderr.write = ((chunk: string | Uint8Array) => {
		stderr += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
		return true;
	}) as typeof process.stderr.write;

	try {
		const code = await runCreate([...argv], cwd);
		return {
			code,
			stdout: stdout || undefined,
			stderr: stderr || undefined,
		};
	} finally {
		process.stdout.write = originalStdoutWrite;
		process.stderr.write = originalStderrWrite;
	}
}

/**
 * Formats scaffold output for display in the CLI.
 *
 * @param result - The scaffold result to format
 * @returns The formatted output text
 */
function formatScaffoldResult(result: ReturnType<typeof scaffoldOpenApi>, ui: Ui): string {
	const lines = [
		ui.success(
			`${result.preview ? "Previewed" : "Scaffolded"} ${result.routes.length} Routa route file(s).`,
		),
		...result.files,
	];

	if (result.preview && result.changes.length > 0) {
		lines.push("", "Preview diff:");

		for (const change of result.changes) {
			lines.push(
				`${previewMarker(change.status, ui)} ${change.path}${change.detail ? ` (${change.detail})` : ""}`,
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
function previewMarker(status: ScaffoldPreviewChange["status"], ui: Ui): string {
	switch (status) {
		case "add":
			return ui.success("+ add");
		case "update":
			return ui.warn("~ update");
		case "unchanged":
			return ui.muted("= unchanged");
		case "conflict":
			return ui.error("! conflict");
		case "remove":
			return ui.warn("- remove");
	}
}

/**
 * Runs the CLI command and writes its output to the process streams.
 *
 * @param argv - Command-line arguments to process
 */
export function main(argv = process.argv.slice(2)): void {
	if (argv[0] === "create") {
		runCreate(argv.slice(1))
			.then((code) => {
				process.exitCode = code;
			})
			.catch((error) => {
				process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
				process.exitCode = 1;
			});
		return;
	}

	if (argv[0] === "dev") {
		runProjectDevProcess(argv.slice(1));
		return;
	}

	const result = run(argv, { color: shouldUseColor() });

	if (result instanceof Promise) {
		result
			.then((resolved) => {
				writeCommandResult(resolved);
			})
			.catch((error) => {
				process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
				process.exitCode = 1;
			});
		return;
	}

	writeCommandResult(result);
}

function writeCommandResult(result: CommandResult): void {
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
