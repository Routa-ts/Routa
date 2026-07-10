#!/usr/bin/env node

import { spawnSync } from "node:child_process";

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
