#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { build } from "esbuild";

const root = resolve(import.meta.dirname, "..");
const packageName = process.argv[2];

const configs = {
	"@routa/cli": {
		dir: "packages/cli",
		bundle: {
			entry: "src/index.ts",
			outfile: "dist/index.js",
			external: ["@hono/node-server", "@routa/core", "@routa/core/*", "tsx", "typescript", "yaml"],
		},
	},
	"@routa/core": {
		dir: "packages/core",
	},
	"create-routa": {
		dir: "packages/create-routa",
		bundle: {
			entry: "src/index.ts",
			outfile: "dist/index.js",
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

run("tsc", ["-p", "tsconfig.json"], packageDir);
removeMaps(join(packageDir, "dist"));
removeSourceMapReferences(join(packageDir, "dist"));

if (config.bundle) {
	removeJavaScript(join(packageDir, "dist"));

	await build({
		entryPoints: [join(packageDir, config.bundle.entry)],
		outfile: join(packageDir, config.bundle.outfile),
		bundle: true,
		format: "esm",
		platform: "node",
		target: "node20",
		sourcemap: false,
		external: config.bundle.external,
	});
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
