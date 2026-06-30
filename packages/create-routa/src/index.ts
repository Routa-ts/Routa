#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { createProject } from "./create-project.js";
import { createUi, shouldUseColor, type Ui } from "./ui.js";

export { createProject } from "./create-project.js";

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
 * @returns `0` on success or cancellation, `1` if project creation fails
 */
export async function runCreate(
	argv = process.argv.slice(2),
	cwd = process.cwd(),
): Promise<number> {
	const config = await resolveCreateConfig(argv, cwd);
	const ui = createUi(shouldUseColor());

	try {
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

		if (config.git) {
			const git = spawnSync("git", ["init"], {
				cwd: result.projectDir,
				encoding: "utf8",
			});

			if (git.status === 0) {
				process.stdout.write(`${ui.success("Initialized git repository.")}\n`);
			} else {
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
		return 0;
	} catch (error) {
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
 * Prompts for a yes-or-no response.
 *
 * @param label - The prompt text shown to the user
 * @param defaultValue - The value used when the user submits an empty response
 * @returns `true` if the user answers yes, `false` otherwise
 */
async function confirm(label: string, defaultValue: boolean): Promise<boolean> {
	const suffix = defaultValue ? "Y/n" : "y/N";
	const answer = (await question(`${label} (${suffix})`)).trim().toLowerCase();

	if (!answer) {
		return defaultValue;
	}

	return ["y", "yes"].includes(answer);
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

if (isCliEntry()) {
	runCreate()
		.then((code) => {
			process.exitCode = code;
		})
		.catch((error) => {
			process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
			process.exitCode = 1;
		});
}

/**
 * Determines whether this module is being executed directly.
 *
 * @returns `true` if the current process entry point matches this module, `false` otherwise.
 */
function isCliEntry(): boolean {
	if (!process.argv[1]) {
		return false;
	}

	try {
		const entry = realpathSync(process.argv[1]);
		const modulePath = realpathSync(fileURLToPath(import.meta.url));
		const normalizedEntry = entry.split(sep).join("/");

		return entry === modulePath && normalizedEntry.includes("/create-routa/");
	} catch {
		return false;
	}
}
