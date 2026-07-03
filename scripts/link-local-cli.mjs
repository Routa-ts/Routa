#!/usr/bin/env node

import { chmodSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const shim = [
	"#!/usr/bin/env sh",
	`exec node "${join(root, "packages/cli/dist/index.js")}" "$@"`,
	"",
].join("\n");

for (const binDir of [join(root, "node_modules/.bin"), ...exampleBinDirs()]) {
	try {
		mkdirSync(binDir, { recursive: true });
		const binPath = join(binDir, "routa");
		writeFileSync(binPath, shim);
		chmodSync(binPath, 0o755);
	} catch (error) {
		const detail = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to prepare release CLI shim at ${binDir}: ${detail}`);
	}
}

function exampleBinDirs() {
	const examplesDir = join(root, "examples");

	if (!existsSync(examplesDir)) {
		return [];
	}

	return readdirSync(examplesDir)
		.map((entry) => join(examplesDir, entry))
		.filter((path) => statSync(path).isDirectory() && existsSync(join(path, "package.json")))
		.map((path) => join(path, "node_modules/.bin"));
}
