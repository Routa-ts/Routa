#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const packageName = process.argv[2];

const configs = {
	"@routa-ts/cli": {
		dir: "packages/cli",
		bundle: {
			entries: [
				{ entry: "src/index.ts", outfile: "dist/index.js" },
				// runtime.js is spawned by filesystem path from project.ts, so it must
				// be emitted explicitly; it is never statically imported from index.ts.
				{ entry: "src/runtime.ts", outfile: "dist/runtime.js" },
			],
			external: [
				"@hono/node-server",
				"@routa-ts/core",
				"@routa-ts/core/*",
				"tsx",
				"typescript",
				"typescript/*",
				"yaml",
			],
			requiredOutputs: ["dist/index.js", "dist/runtime.js"],
		},
	},
	"@routa-ts/core": {
		dir: "packages/core",
	},
	"create-routa-ts": {
		dir: "packages/create-routa-ts",
		bundle: {
			entries: [
				{ entry: "src/index.ts", outfile: "dist/index.js" },
				{ entry: "src/cli.ts", outfile: "dist/cli.js" },
			],
			external: [],
		},
	},
};

const config = configs[packageName];

if (!config) {
	process.stderr.write(`Unknown package build target: ${packageName ?? "(missing)"}\n`);
	process.exit(1);
}

const packageDir = join(root, config.dir);
const distDir = join(packageDir, "dist");

rmSync(distDir, { recursive: true, force: true });
run("tsc", ["-p", "tsconfig.json"], packageDir);
removeMaps(distDir);
removeSourceMapReferences(distDir);

if (config.bundle) {
	removeJavaScript(distDir);

	for (const entry of config.bundle.entries) {
		await build({
			entryPoints: [join(packageDir, entry.entry)],
			outfile: join(packageDir, entry.outfile),
			bundle: true,
			format: "esm",
			platform: "node",
			target: "node24",
			sourcemap: false,
			external: config.bundle.external,
		});
	}

	for (const requiredOutput of config.bundle.requiredOutputs ?? []) {
		if (!existsSync(join(packageDir, requiredOutput))) {
			process.stderr.write(`${packageName} build did not produce ${requiredOutput}.\n`);
			process.exit(1);
		}
	}
}

function run(command, args, cwd) {
	const result = spawnSync(command, args, {
		cwd,
		stdio: "inherit",
		shell: process.platform === "win32",
	});

	if (result.status !== 0) {
		process.exit(result.status ?? 1);
	}
}

function removeMaps(dir) {
	for (const file of walk(dir)) {
		if (file.endsWith(".map")) {
			rmSync(file);
		}
	}
}

function removeJavaScript(dir) {
	for (const file of walk(dir)) {
		if (file.endsWith(".js")) {
			rmSync(file);
		}
	}
}

function removeSourceMapReferences(dir) {
	for (const file of walk(dir)) {
		if (!file.endsWith(".js") && !file.endsWith(".d.ts")) {
			continue;
		}

		const content = readFileSync(file, "utf8");
		const next = content.replace(/\n?\/\/# sourceMappingURL=.*(?:\n|$)/g, "\n");

		if (next !== content) {
			writeFileSync(file, next);
		}
	}
}

function* walk(dir) {
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		const stats = statSync(path);

		if (stats.isDirectory()) {
			yield* walk(path);
		} else {
			yield path;
		}
	}
}
