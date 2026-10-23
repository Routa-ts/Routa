#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// This example is a pristine regeneration fixture. Other examples contain
// intentional application-owned edits and must not be held to manifest hashes.
const scaffoldRoot = "examples/full-api/scaffold";
const manifest = JSON.parse(readFileSync(join(scaffoldRoot, ".routa/manifest.json"), "utf8"));
const conflicts = manifest.generated.filter(
	({ path, sha256 }) =>
		createHash("sha256")
			.update(readFileSync(join(scaffoldRoot, path)))
			.digest("hex") !== sha256,
);
if (conflicts.length) {
	process.stderr.write(
		`Scaffold fixture has local edits: ${conflicts.map(({ path }) => path).join(", ")}\n`,
	);
	process.exit(1);
}

const generatedPaths = ["examples/basic-api/.routa", "examples/full-api/.routa"];
const result = spawnSync("git", ["diff", "--exit-code", "--", ...generatedPaths], {
	stdio: "inherit",
});

if (result.status !== 0) {
	process.stderr.write(
		"Generated Routa metadata changed. Review the diff and commit it with the source change.\n",
	);
	process.exit(result.status ?? 1);
}
