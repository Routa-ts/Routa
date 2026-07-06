import { spawnSync } from "node:child_process";

process.env.ASTRO_TELEMETRY_DISABLED = "1";

const result = spawnSync("astro", process.argv.slice(2), {
	stdio: "inherit",
	shell: process.platform === "win32",
});

process.exitCode = result.status ?? 1;
