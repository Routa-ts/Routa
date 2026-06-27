#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { createProject } from "./create-project.js";

export { createProject } from "./create-project.js";

type CreateConfig = {
	targetDir: string;
	openApi: boolean;
	git: boolean;
	install: boolean;
	interactive: boolean;
	cwd: string;
};

export function createCommandArgs(argv: readonly string[]): string[] {
	return ["create", ...argv];
}

export async function runCreate(
	argv = process.argv.slice(2),
	cwd = process.cwd(),
): Promise<number> {
	const config = await resolveCreateConfig(argv, cwd);

	try {
		printSummary(config);

		if (config.interactive && !(await confirm("Continue with these settings?", true))) {
			process.stdout.write("Creation cancelled.\n");
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
				process.stdout.write("Initialized git repository.\n");
			} else {
				process.stderr.write(`git init failed. ${git.stderr ?? ""}\n`);
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
					'Command "pnpm install" did not run successfully. Please run this manually in your project.\n',
				);
			}
		}

		process.stdout.write(`\nYour Routa app is ready in '${config.targetDir}'.\n\n`);
		process.stdout.write("Use the following commands to start your app:\n");
		process.stdout.write(`cd ${config.targetDir}\n`);

		if (!config.install) {
			process.stdout.write("pnpm install\n");
		}

		process.stdout.write("pnpm dev\n");
		return 0;
	} catch (error) {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		return 1;
	}
}

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

async function resolveCreateConfig(argv: readonly string[], cwd: string): Promise<CreateConfig> {
	const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
	const targetArg = argv.find((item) => !item.startsWith("--"));
	let targetDir = targetArg ?? "routa-app";

	if (interactive && !targetArg) {
		const answer = await question("Project name (leave empty to use routa-app)");
		targetDir = answer.trim() || targetDir;
	}

	return {
		targetDir,
		openApi: await flagOrPrompt(
			argv,
			"--openapi",
			"--no-openapi",
			"Include a starter OpenAPI file?",
			true,
		),
		git: await flagOrPrompt(
			argv,
			"--git",
			"--no-git",
			"Initialize a new git repository?",
			interactive,
		),
		install: await flagOrPrompt(
			argv,
			"--install",
			"--no-install",
			"Install dependencies?",
			interactive,
		),
		interactive,
		cwd,
	};
}

async function flagOrPrompt(
	argv: readonly string[],
	enabledFlag: string,
	disabledFlag: string,
	label: string,
	defaultValue: boolean,
): Promise<boolean> {
	if (argv.includes(enabledFlag)) {
		return true;
	}

	if (argv.includes(disabledFlag)) {
		return false;
	}

	if (!process.stdin.isTTY || !process.stdout.isTTY) {
		return defaultValue;
	}

	return await confirm(label, defaultValue);
}

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

async function confirm(label: string, defaultValue: boolean): Promise<boolean> {
	const suffix = defaultValue ? "Y/n" : "y/N";
	const answer = (await question(`${label} (${suffix})`)).trim().toLowerCase();

	if (!answer) {
		return defaultValue;
	}

	return ["y", "yes"].includes(answer);
}

function printSummary(config: CreateConfig): void {
	process.stdout.write("Let's configure your Routa API\n\n");
	process.stdout.write("About to create:\n\n");
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
