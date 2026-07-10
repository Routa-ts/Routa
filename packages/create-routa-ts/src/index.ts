#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { emitKeypressEvents } from "node:readline";
import { createInterface } from "node:readline/promises";
import { createProject } from "./create-project.js";
import { createUi, shouldUseColor, type Ui } from "./ui.js";

export { createProject } from "./create-project.js";
export { createUi, shouldUseColor, type Ui } from "./ui.js";

type CreateConfig = {
	targetDir: string;
	openApi: boolean;
	git: boolean;
	install: boolean;
	interactive: boolean;
	prompted: boolean;
	yes: boolean;
	cwd: string;
};

class UserCancelledError extends Error {
	constructor() {
		super("Creation cancelled.");
	}
}

/**
 * Prepends the create subcommand to an argument list.
 *
 * @param argv - The original command-line arguments
 * @returns The arguments with `"create"` inserted at the beginning
 */
export function createCommandArgs(argv: readonly string[]): string[] {
	return ["create", ...argv];
}

/**
 * Creates a new Routa app from the provided command-line arguments.
 *
 * @param argv - Command-line arguments to parse
 * @param cwd - Current working directory used to resolve paths
 * @returns `0` on success or cancellation, `1` if project creation, git init, or install fails
 */
export async function runCreate(
	argv = process.argv.slice(2),
	cwd = process.cwd(),
): Promise<number> {
	const ui = createUi(shouldUseColor());

	try {
		const config = await resolveCreateConfig(argv, cwd);

		printSummary(config, ui);

		if (
			config.interactive
			&& config.prompted
			&& !config.yes
			&& !(await confirm("Continue with these settings?", true))
		) {
			process.stdout.write(`${ui.muted("Creation cancelled.")}\n`);
			return 0;
		}

		const result = createProject(config.targetDir, cwd, {
			openApi: config.openApi,
			routaVersion: resolveRoutaVersion(config.cwd, config.targetDir),
		});

		let postCreateFailed = false;

		if (config.git) {
			const git = spawnSync("git", ["init"], {
				cwd: result.projectDir,
				encoding: "utf8",
			});

			if (git.status === 0) {
				process.stdout.write(`${ui.success("Initialized git repository.")}\n`);
			} else {
				postCreateFailed = true;
				process.stderr.write(`${ui.error("git init failed.")} ${git.stderr ?? ""}\n`);
			}
		}

		if (config.install) {
			const install = spawnSync("pnpm", ["install"], {
				cwd: result.projectDir,
				encoding: "utf8",
				stdio: "inherit",
			});

			if (install.status !== 0) {
				postCreateFailed = true;
				process.stderr.write(
					`${ui.error('Command "pnpm install" did not run successfully.')} Please run this manually in your project.\n`,
				);
			}
		}

		process.stdout.write(
			`\n${ui.success(`Your Routa app is ready in '${config.targetDir}'.`)}\n\n`,
		);
		process.stdout.write("Use the following commands to start your app:\n");
		process.stdout.write(`${ui.command(`cd ${config.targetDir}`)}\n`);

		if (!config.install) {
			process.stdout.write(`${ui.command("pnpm install")}\n`);
		}

		process.stdout.write(`${ui.command("pnpm dev")}\n`);
		return postCreateFailed ? 1 : 0;
	} catch (error) {
		if (error instanceof UserCancelledError) {
			process.stdout.write(`${ui.muted("Creation cancelled.")}\n`);
			return 0;
		}

		process.stderr.write(
			`${ui.error("Error:")} ${error instanceof Error ? error.message : String(error)}\n`,
		);
		return 1;
	}
}

/**
 * Resolves the Routa package version for a new project.
 *
 * @param cwd - The current working directory used to locate a pnpm workspace
 * @param targetDir - The target project directory
 * @returns `"workspace:*"` for example projects in matching workspaces, `"latest"` otherwise
 */
export function resolveRoutaVersion(cwd: string, targetDir: string): "latest" | "workspace:*" {
	const workspaceRoot = findWorkspaceRoot(cwd);

	if (!workspaceRoot) {
		return "latest";
	}

	const workspaceConfig = readFileSync(join(workspaceRoot, "pnpm-workspace.yaml"), "utf8");
	const projectPath = resolve(cwd, targetDir);
	const projectRelativePath = relative(workspaceRoot, projectPath).split(sep).join("/");

	if (workspaceConfig.includes("examples/*") && projectRelativePath.startsWith("examples/")) {
		return "workspace:*";
	}

	return "latest";
}

/**
 * Finds the nearest pnpm workspace root for a directory.
 *
 * @param cwd - The directory to start searching from
 * @returns The path to the first directory containing `pnpm-workspace.yaml`, or `undefined` if none is found
 */
function findWorkspaceRoot(cwd: string): string | undefined {
	let current = resolve(cwd);

	while (true) {
		if (existsSync(join(current, "pnpm-workspace.yaml"))) {
			return current;
		}

		const parent = dirname(current);

		if (parent === current) {
			return undefined;
		}

		current = parent;
	}
}

/**
 * Resolves project creation settings from command-line arguments and prompts.
 *
 * @param argv - Command-line arguments after the command name
 * @param cwd - Current working directory
 * @returns The resolved creation configuration
 */
async function resolveCreateConfig(argv: readonly string[], cwd: string): Promise<CreateConfig> {
	const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
	const targetArg = argv.find((item) => !item.startsWith("-"));
	let targetDir = targetArg ?? "routa-app";
	let prompted = false;

	if (interactive && !targetArg) {
		const answer = await question("Project name (leave empty to use routa-app)");
		prompted = true;
		targetDir = answer.trim() || targetDir;
	}
	const openApi = await flagOrPrompt(
		argv,
		"--openapi",
		"--no-openapi",
		"Include a starter OpenAPI file?",
		true,
	);
	const git = await flagOrPrompt(
		argv,
		"--git",
		"--no-git",
		"Initialize a new git repository?",
		interactive,
	);
	const install = await flagOrPrompt(
		argv,
		"--install",
		"--no-install",
		"Install dependencies?",
		interactive,
	);
	prompted = prompted || openApi.prompted || git.prompted || install.prompted;

	return {
		targetDir,
		openApi: openApi.value,
		git: git.value,
		install: install.value,
		interactive,
		prompted,
		yes: argv.includes("--yes") || argv.includes("-y"),
		cwd,
	};
}

/**
 * Resolves a boolean option from CLI flags or an interactive prompt.
 *
 * @param argv - The command-line arguments to inspect.
 * @param enabledFlag - The flag that enables the option.
 * @param disabledFlag - The flag that disables the option.
 * @param label - The prompt text shown when asking the user.
 * @param defaultValue - The value used when prompting is unavailable.
 * @returns The resolved boolean option value.
 */
async function flagOrPrompt(
	argv: readonly string[],
	enabledFlag: string,
	disabledFlag: string,
	label: string,
	defaultValue: boolean,
): Promise<{ value: boolean; prompted: boolean }> {
	if (argv.includes(enabledFlag)) {
		return { value: true, prompted: false };
	}

	if (argv.includes(disabledFlag)) {
		return { value: false, prompted: false };
	}

	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		return { value: defaultValue, prompted: false };
	}

	return { value: await confirm(label, defaultValue), prompted: true };
}

/**
 * Prompts for a line of user input.
 *
 * @param label - The prompt text to display
 * @returns The text entered by the user
 */
async function question(label: string): Promise<string> {
	const prompt = createInterface({
		input: process.stdin,
		output: process.stdout,
	});

	try {
		return await prompt.question(`${label}\n> `);
	} finally {
		prompt.close();
	}
}

/**
 * Prompts for a yes-or-no response using an arrow-key selector.
 *
 * @param label - The prompt text shown to the user
 * @param defaultValue - The selected value shown before user input
 * @returns `true` if the user selects yes, `false` otherwise
 */
async function confirm(label: string, defaultValue: boolean): Promise<boolean> {
	let selected = defaultValue;
	const input = process.stdin;
	const output = process.stdout;
	const rawMode = input.isRaw;
	const color = shouldUseColor();

	emitKeypressEvents(input);
	output.write(`${label}\n`);
	renderBooleanSelect(selected, color);

	if (typeof input.setRawMode === "function") {
		input.setRawMode(true);
	}

	input.resume();

	return await new Promise<boolean>((resolve, reject) => {
		const cleanup = () => {
			input.off("keypress", onKeypress);

			if (typeof input.setRawMode === "function") {
				input.setRawMode(rawMode ?? false);
			}

			input.pause();
			output.write("\n");
		};
		const finish = (value: boolean) => {
			cleanup();
			resolve(value);
		};
		const onKeypress = (_value: string, key?: { name?: string; ctrl?: boolean }) => {
			if ((key?.ctrl && key.name === "c") || key?.name === "escape") {
				cleanup();
				reject(new UserCancelledError());
				return;
			}

			if (key?.name === "left" || key?.name === "up") {
				selected = true;
				rerenderBooleanSelect(selected, color);
				return;
			}

			if (key?.name === "right" || key?.name === "down") {
				selected = false;
				rerenderBooleanSelect(selected, color);
				return;
			}

			if (key?.name === "tab") {
				selected = !selected;
				rerenderBooleanSelect(selected, color);
				return;
			}

			if (key?.name === "y") {
				finish(true);
				return;
			}

			if (key?.name === "n") {
				finish(false);
				return;
			}

			if (key?.name === "return" || key?.name === "enter") {
				finish(selected);
			}
		};

		input.on("keypress", onKeypress);
	});
}

function renderBooleanSelect(selected: boolean, color: boolean): void {
	process.stdout.write(`  ${choice("Yes", selected, color)} / ${choice("No", !selected, color)}`);
}

function rerenderBooleanSelect(selected: boolean, color: boolean): void {
	process.stdout.write("\r\u001b[2K");
	renderBooleanSelect(selected, color);
}

function choice(label: string, selected: boolean, color: boolean): string {
	const marker = selected ? "●" : "○";
	const value = `${marker} ${label}`;

	if (!color) {
		return value;
	}

	return selected ? `\u001b[92m${value}\u001b[0m` : `\u001b[2m${value}\u001b[0m`;
}

/**
 * Prints a summary of the project configuration.
 *
 * @param config - The resolved project creation settings
 */
function printSummary(config: CreateConfig, ui: Ui): void {
	process.stdout.write(`${ui.heading("Let's configure your Routa API")}\n\n`);
	process.stdout.write(`${ui.muted("About to create:")}\n\n`);
	process.stdout.write(`  Project:         ${config.targetDir}\n`);
	process.stdout.write(`  Location:        ${config.cwd}/${config.targetDir}\n`);
	process.stdout.write("  Package manager: pnpm\n");
	process.stdout.write("  Toolchain:       TypeScript, Biome\n");
	process.stdout.write(`  OpenAPI starter: ${config.openApi ? "yes" : "no"}\n`);
	process.stdout.write(`  Initialize git:  ${config.git ? "yes" : "no"}\n`);
	process.stdout.write(`  Install deps:    ${config.install ? "yes" : "no"}\n\n`);
}
