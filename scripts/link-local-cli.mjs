#!/usr/bin/env node

import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const shim = [
	"#!/usr/bin/env sh",
	`exec node "${join(root, "packages/cli/dist/index.js")}" "$@"`,
	"",
].join("\n");

for (const binDir of [
	join(root, "node_modules/.bin"),
	join(root, "examples/basic-api/node_modules/.bin"),
	join(root, "examples/full-api/node_modules/.bin"),
]) {
	mkdirSync(binDir, { recursive: true });
	const binPath = join(binDir, "routa");
	writeFileSync(binPath, shim);
	chmodSync(binPath, 0o755);
}
