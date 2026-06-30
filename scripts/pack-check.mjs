#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const tmp = mkdtempSync(join(tmpdir(), "routa-pack-check-"));
const packDir = join(tmp, "packs");
const appDir = join(tmp, "app");

const packages = ["@routa/core", "create-routa", "@routa/cli"];
const tarballs = new Map();

run("pnpm", ["build"], root);
mkdirSync(packDir, { recursive: true });

for (const packageName of packages) {
	const output = run(
		"pnpm",
		["--filter", packageName, "pack", "--pack-destination", packDir],
		root,
	);
	const tarball = output
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line.endsWith(".tgz"));

	if (!tarball) {
		throw new Error(`Could not find packed tarball for ${packageName}.\n${output}`);
	}

	tarballs.set(packageName, tarball);
	const packageJson = run("tar", ["-xOf", tarball, "package/package.json"], root);

	if (packageJson.includes("workspace:")) {
		throw new Error(`${packageName} tarball contains a workspace: dependency.`);
	}
}

run(
	"pnpm",
	["dlx", `file:${tarballs.get("create-routa")}`, appDir, "--no-git", "--no-install", "--yes"],
	root,
);

const manifestPath = join(appDir, "package.json");
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.dependencies["@routa/core"] = `file:${tarballs.get("@routa/core")}`;
manifest.dependencies["@routa/cli"] = `file:${tarballs.get("@routa/cli")}`;
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
writeFileSync(
	join(appDir, "pnpm-workspace.yaml"),
	`overrides:\n  "@routa/cli": "file:${tarballs.get("@routa/cli")}"\n  "@routa/core": "file:${tarballs.get("@routa/core")}"\n  "create-routa": "file:${tarballs.get("create-routa")}"\nallowBuilds:\n  esbuild: true\n`,
);

run("pnpm", ["install"], appDir);
run("pnpm", ["exec", "routa", "check"], appDir);
run("pnpm", ["exec", "routa", "build"], appDir);

process.stdout.write(`Pack check passed in ${basename(tmp)}.\n`);

function run(command, args, cwd) {
	const result = spawnSync(command, args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		shell: process.platform === "win32",
	});

	if (result.status !== 0) {
		process.stdout.write(result.stdout);
		process.stderr.write(result.stderr);
		process.exit(result.status ?? 1);
	}

	if (result.stderr) {
		process.stderr.write(result.stderr);
	}

	return result.stdout;
}
