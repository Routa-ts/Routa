#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

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

const cliTarballFiles = run("tar", ["-tf", tarballs.get("@routa/cli")], root);

for (const requiredFile of ["package/dist/index.js", "package/dist/runtime.js"]) {
	if (!cliTarballFiles.split("\n").includes(requiredFile)) {
		throw new Error(`@routa/cli tarball is missing ${requiredFile}.`);
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
await smokeTestStart(appDir);

process.stdout.write(`Pack check passed in ${basename(tmp)}.\n`);

/**
 * Starts the packaged `routa start` server and verifies it serves the starter route.
 *
 * This guards the packaged runtime entry (dist/runtime.js), which `routa check`
 * and `routa build` never exercise.
 */
async function smokeTestStart(cwd) {
	const port = await freePort();
	// detached puts the pnpm -> routa -> node chain in its own process group so
	// the whole tree can be killed once the smoke test finishes.
	const child = spawn("pnpm", ["exec", "routa", "start"], {
		cwd,
		env: { ...process.env, PORT: String(port), HOST: "127.0.0.1" },
		stdio: ["ignore", "pipe", "pipe"],
		shell: process.platform === "win32",
		detached: process.platform !== "win32",
	});
	let output = "";
	child.stdout.on("data", (chunk) => {
		output += chunk;
	});
	child.stderr.on("data", (chunk) => {
		output += chunk;
	});

	try {
		const deadline = Date.now() + 30_000;

		while (true) {
			if (child.exitCode !== null) {
				throw new Error(`routa start exited early with code ${child.exitCode}.\n${output}`);
			}

			try {
				const remainingMs = deadline - Date.now();
				if (remainingMs <= 0) {
					throw new Error(`routa start smoke test timed out after 30s.\n${output}`);
				}

				// Abort fetch + response body parsing so we never hang longer than the
				// overall smoke-test deadline.
				const controller = new AbortController();
				const timeoutId = setTimeout(() => controller.abort(), remainingMs);

				try {
					const response = await fetch(`http://127.0.0.1:${port}/status`, {
						signal: controller.signal,
					});
					const body = await response.json();

					if (response.status !== 200 || body.ok !== true) {
						throw new Error(
							`routa start smoke test got ${response.status} ${JSON.stringify(body)}.\n${output}`,
						);
					}

					return;
				} finally {
					clearTimeout(timeoutId);
				}
			} catch (error) {
				if (error instanceof Error && error.name === "AbortError") {
					throw new Error(`routa start smoke test timed out after 30s.\n${output}`);
				}

				if (Date.now() >= deadline) {
					throw new Error(`routa start smoke test timed out after 30s.\n${output}`);
				}

				// When the server isn't up yet, fetch usually throws a TypeError.
				// Retry while there is time remaining.
				if (error instanceof TypeError && Date.now() < deadline) {
					await sleep(250);
					continue;
				}

				throw error;
			}
		}
	} finally {
		if (process.platform !== "win32" && child.pid) {
			try {
				process.kill(-child.pid, "SIGTERM");
			} catch {
				child.kill("SIGTERM");
			}
		} else {
			child.kill("SIGTERM");
		}
	}
}

function freePort() {
	return new Promise((resolvePort, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const { port } = server.address();
			server.close(() => resolvePort(port));
		});
	});
}

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
