import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const bundledTsc = require.resolve("typescript/bin/tsc");

export type TypeScriptResult = {
	code: number;
	stdout?: string;
	stderr?: string;
};

/**
 * Runs a project's local TypeScript compiler, then Routa's bundled compiler as a portable fallback.
 */
export function runTypeScript(cwd: string, args: string[]): TypeScriptResult {
	if (!existsSync(join(cwd, "tsconfig.json"))) {
		return { code: 0 };
	}

	const localTsc = join(cwd, "node_modules", ".bin", "tsc");
	const result = existsSync(localTsc)
		? spawnSync(localTsc, args, {
				cwd,
				encoding: "utf8",
				shell: process.platform === "win32",
			})
		: spawnSync(process.execPath, [bundledTsc, ...args], {
				cwd,
				encoding: "utf8",
			});

	return {
		code: result.status ?? 1,
		stdout: result.stdout,
		stderr: result.stderr || result.error?.message,
	};
}
