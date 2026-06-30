#!/usr/bin/env node

import { runCreate } from "./index.js";

runCreate()
	.then((code) => {
		process.exitCode = code;
	})
	.catch((error) => {
		process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 1;
	});
