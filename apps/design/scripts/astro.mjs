import { spawnSync } from "node:child_process";

process.env.ASTRO_TELEMETRY_DISABLED = "1";

// Astro exits 0 when it cannot load @astrojs/check, so a broken install would skip the check.
// Load it first: any failure here exits non-zero with the real error.
if (process.argv[2] === "check") await import("@astrojs/check");

const result = spawnSync("astro", process.argv.slice(2), {
	stdio: "inherit",
	shell: process.platform === "win32",
});

process.exitCode = result.status ?? 1;
