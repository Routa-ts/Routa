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

const packages = ["@routa-ts/core", "create-routa-ts", "@routa-ts/cli"];
const tarballs = new Map();

/** A route using a declared header, a bodyless outcome, and two cookie handles. */
const responseContractRoute = `import { createCookie, createRoute, createRouteRoot } from "@routa-ts/core";
import { z } from "zod";

const session = createCookie({
	name: "session",
	schema: z.string(),
	httpOnly: true,
	secure: true,
	sameSite: "lax",
	path: "/",
});

const theme = createCookie({
	name: "theme",
	schema: z.enum(["light", "dark"]),
	httpOnly: false,
	secure: true,
	sameSite: "lax",
	path: "/",
});

export default createRouteRoot("/session")({
	post: createRoute({
		responses: {
			created: {
				status: 201,
				schema: z.object({ id: z.string() }),
				headers: z.object({ location: z.string() }),
				cookies: [session, theme],
			},
		},
		run: () => ({
			type: "created",
			data: { id: "s_1" },
			headers: { location: "/session" },
			cookies: [session.set("a b"), theme.set("dark")],
		}),
	}),
	delete: createRoute({
		responses: { deleted: { status: 204, cookies: [{ handle: session, required: true }] } },
		run: () => ({ type: "deleted", cookies: [session.clear()] }),
	}),
});
`;

run("vp", ["run", "build:packages"], root);
mkdirSync(packDir, { recursive: true });
writeFileSync(
	join(tmp, "package.json"),
	JSON.stringify({ private: true, packageManager: "pnpm@11.9.0" }),
);

for (const packageName of packages) {
	const output = run(
		"vp",
		["pm", "pack", "--filter", packageName, "--pack-destination", packDir],
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

const cliTarballFiles = run("tar", ["-tf", tarballs.get("@routa-ts/cli")], root);

for (const requiredFile of ["package/dist/index.js", "package/dist/runtime.js"]) {
	if (!cliTarballFiles.split("\n").includes(requiredFile)) {
		throw new Error(`@routa-ts/cli tarball is missing ${requiredFile}.`);
	}
}

const createTarballFiles = run("tar", ["-tf", tarballs.get("create-routa-ts")], root);

for (const requiredFile of ["package/dist/cli.js", "package/dist/index.js"]) {
	if (!createTarballFiles.split("\n").includes(requiredFile)) {
		throw new Error(`create-routa-ts tarball is missing ${requiredFile}.`);
	}
}

const zodRange = readJson(join(root, "packages/core/package.json")).peerDependencies.zod;
const zodFloor = /^\^(\d+\.\d+\.\d+)$/.exec(zodRange)?.[1];

if (!zodFloor) {
	throw new Error(`@routa-ts/core must declare its Zod peer as ^x.y.z, found ${zodRange}.`);
}

for (const example of ["examples/basic-api", "examples/full-api"]) {
	const range = readJson(join(root, example, "package.json")).dependencies.zod;

	if (range !== zodRange) {
		throw new Error(`${example} declares zod ${range}; the @routa-ts/core peer is ${zodRange}.`);
	}
}

// Prove the packed packages against the minimum supported Zod and the version
// the repository resolves, so the peer floor stays honest.
const zodVersions = new Map([[zodFloor, "minimum supported"]]);
const resolvedZod = readJson(join(root, "packages/core/node_modules/zod/package.json")).version;
zodVersions.set(
	resolvedZod,
	zodVersions.has(resolvedZod)
		? "minimum supported and repository-resolved"
		: "repository-resolved",
);

for (const [zodVersion, label] of zodVersions) {
	const name = `app-zod-${zodVersion}`;
	const appDir = join(tmp, name);
	run(
		"vp",
		["dlx", `file:${tarballs.get("create-routa-ts")}`, name, "--no-git", "--no-install", "--yes"],
		tmp,
	);

	const manifestPath = join(appDir, "package.json");
	const manifest = readJson(manifestPath);

	if (manifest.dependencies.zod !== zodRange) {
		throw new Error(
			`Generated projects declare zod ${manifest.dependencies.zod}; the @routa-ts/core peer is ${zodRange}.`,
		);
	}

	manifest.dependencies["@routa-ts/core"] = `file:${tarballs.get("@routa-ts/core")}`;
	manifest.dependencies["@routa-ts/cli"] = `file:${tarballs.get("@routa-ts/cli")}`;
	manifest.dependencies.zod = zodVersion;
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
	writeFileSync(
		join(appDir, "pnpm-workspace.yaml"),
		`overrides:\n  "@routa-ts/cli": "file:${tarballs.get("@routa-ts/cli")}"\n  "@routa-ts/core": "file:${tarballs.get("@routa-ts/core")}"\n  "create-routa-ts": "file:${tarballs.get("create-routa-ts")}"\n  zod: "${zodVersion}"\nallowBuilds:\n  esbuild: true\n`,
	);

	run("vp", ["install"], appDir);
	const installedZod = readJson(join(appDir, "node_modules/zod/package.json")).version;

	if (installedZod !== zodVersion) {
		throw new Error(`Expected zod ${zodVersion} (${label}), but installed ${installedZod}.`);
	}

	run("vp", ["exec", "routa", "check"], appDir);
	run("vp", ["exec", "routa", "build"], appDir);
	run("vp", ["run", "test"], appDir);
	run("vp", ["exec", "routa", "openapi", "check"], appDir);
	// The starter has no response headers or cookies, so prove them through the packed
	// packages with one more route after the starter's own checks.
	mkdirSync(join(appDir, "src/routes/session"), { recursive: true });
	writeFileSync(join(appDir, "src/routes/session/route.ts"), responseContractRoute);
	run("vp", ["exec", "routa", "build"], appDir);
	run("vp", ["exec", "routa", "check"], appDir);
	await smokeTestStart(appDir);
	process.stdout.write(`Packed consumer passed with zod ${zodVersion} (${label}).\n`);
}

const noOpenApiDir = join(tmp, "app-no-openapi");
run(
	"vp",
	[
		"dlx",
		`file:${tarballs.get("create-routa-ts")}`,
		"app-no-openapi",
		"--no-openapi",
		"--no-git",
		"--no-install",
		"--yes",
	],
	tmp,
);
const noOpenApiManifestPath = join(noOpenApiDir, "package.json");
const noOpenApiManifest = readJson(noOpenApiManifestPath);
noOpenApiManifest.dependencies["@routa-ts/core"] = `file:${tarballs.get("@routa-ts/core")}`;
noOpenApiManifest.dependencies["@routa-ts/cli"] = `file:${tarballs.get("@routa-ts/cli")}`;
writeFileSync(noOpenApiManifestPath, `${JSON.stringify(noOpenApiManifest, null, "\t")}\n`);
writeFileSync(
	join(noOpenApiDir, "pnpm-workspace.yaml"),
	`overrides:\n  "@routa-ts/cli": "file:${tarballs.get("@routa-ts/cli")}"\n  "@routa-ts/core": "file:${tarballs.get("@routa-ts/core")}"\n  "create-routa-ts": "file:${tarballs.get("create-routa-ts")}"\nallowBuilds:\n  esbuild: true\n`,
);
run("vp", ["install"], noOpenApiDir);
run("vp", ["exec", "routa", "check"], noOpenApiDir);
run("vp", ["exec", "routa", "build"], noOpenApiDir);
run("vp", ["run", "test"], noOpenApiDir);

process.stdout.write(`Pack check passed in ${basename(tmp)}.\n`);

/**
 * Starts the packaged `routa start` server and verifies it serves the starter route and the
 * response contract route.
 *
 * This guards the packaged runtime entry (dist/runtime.js), which `routa check`
 * and `routa build` never exercise.
 */
async function smokeTestStart(cwd) {
	const port = await freePort();
	// detached puts the vp -> routa -> node chain in its own process group so
	// the whole tree can be killed once the smoke test finishes.
	const child = spawn("vp", ["exec", "routa", "start"], {
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

					await checkResponseContract(port, controller.signal, output);
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

/** Checks the response contract route: header, repeated `Set-Cookie` fields, and an empty body. */
async function checkResponseContract(port, signal, output) {
	const observe = async (method) => {
		const response = await fetch(`http://127.0.0.1:${port}/session`, { method, signal });
		return {
			status: response.status,
			location: response.headers.get("location"),
			body: await response.text(),
			cookies: response.headers.getSetCookie(),
		};
	};
	const actual = { created: await observe("POST"), deleted: await observe("DELETE") };
	const expected = {
		created: {
			status: 201,
			location: "/session",
			body: '{"id":"s_1"}',
			cookies: [
				"session=a%20b; Path=/; HttpOnly; Secure; SameSite=Lax",
				"theme=dark; Path=/; Secure; SameSite=Lax",
			],
		},
		deleted: {
			status: 204,
			location: null,
			body: "",
			cookies: [
				"session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; HttpOnly; Secure; SameSite=Lax",
			],
		},
	};

	if (JSON.stringify(actual) !== JSON.stringify(expected)) {
		throw new Error(
			`Response contract smoke test expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}.\n${output}`,
		);
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

function readJson(file) {
	return JSON.parse(readFileSync(file, "utf8"));
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
