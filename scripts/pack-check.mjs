#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { expectNoLeak } from "../packages/contract-rules/src/testing.ts";

const root = resolve(import.meta.dirname, "..");
/** Consumer files the checks copy into scaffolded projects, laid out at their project paths. */
const fixtures = join(import.meta.dirname, "pack-check/fixtures");
const tmp = mkdtempSync(join(tmpdir(), "routa-pack-check-"));
const packDir = join(tmp, "packs");

const packages = ["@routa-ts/core", "create-routa-ts", "@routa-ts/cli"];
const tarballs = new Map();

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

	// Core and the CLI bundle the private contract rules, so no published file may name them.
	const unpacked = mkdtempSync(join(tmp, "unpacked-"));
	run("tar", ["-xzf", tarball, "-C", unpacked], root);
	const namingPrivate = readdirSync(unpacked, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => join(entry.parentPath, entry.name))
		.filter((file) => readFileSync(file, "utf8").includes("@routa-ts/contract-rules"));

	if (namingPrivate.length > 0) {
		throw new Error(
			`${packageName} tarball names the private @routa-ts/contract-rules in ${namingPrivate.join(", ")}.`,
		);
	}

	// Lint the published metadata, then resolve the types the way Node ESM and bundlers do.
	// The packages are ESM-only, so attw skips the CommonJS resolutions.
	run("vp", ["exec", "publint", "run", tarball, "--strict"], root);
	run("vp", ["exec", "attw", tarball, "--profile", "esm-only", "--format", "ascii"], root);
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

	const scaffoldedTesting = readFileSync(join(appDir, ".routa/testing.gen.ts"), "utf8");
	// A consumer test of the generated test application module, and one of the packed public
	// logger: a sink receives redacted events, the default sink writes JSON lines, and TypeScript
	// (through tsc in routa check) rejects a hand-written logger.
	copyFixture("starter", appDir);
	run("vp", ["exec", "routa", "check"], appDir);

	if (readFileSync(join(appDir, ".routa/testing.gen.ts"), "utf8") !== scaffoldedTesting) {
		throw new Error("routa check rewrote the .routa/testing.gen.ts that create-routa-ts wrote.");
	}

	run("vp", ["exec", "routa", "build"], appDir);
	run(process.execPath, [join(fixtures, "compiled-test-app-check.mjs")], appDir);
	run("vp", ["run", "test"], appDir);
	run("vp", ["exec", "routa", "openapi", "check"], appDir);
	// The starter has no response headers or cookies, so prove them through the packed
	// packages with one more route after the starter's own checks: a declared header, a
	// bodyless outcome, and two cookie handles.
	copyFixture("session", appDir);
	run("vp", ["exec", "routa", "build"], appDir);
	run("vp", ["exec", "routa", "check"], appDir);
	const server = await startServer(appDir);
	try {
		await checkResponseContract(server);
	} finally {
		await server.stop();
	}
	process.stdout.write(`Packed consumer passed with zod ${zodVersion} (${label}).\n`);
}

const noOpenApiDir = scaffoldConsumer("app-no-openapi", ["--no-openapi"]);
run("vp", ["exec", "routa", "check"], noOpenApiDir);
run("vp", ["exec", "routa", "build"], noOpenApiDir);
run("vp", ["run", "test"], noOpenApiDir);

// The starter stays authentication-free. A consumer adopts authentication by editing files
// after scaffolding, then routa check (including tsc on the narrowed ctx.auth) and routa start
// prove the packed packages serve the contract. Its src/routa.ts declares one principal schema,
// a Bearer and an API-key scheme, and a priority that differs from declaration order. Its
// routes are a public route reading ctx.auth, a protected route, a key-only route, and a
// smoke-only route that reports, then clears, which authenticators ran.
const authenticatedDir = scaffoldConsumer("app-authenticated", []);
copyFixture("authenticated", authenticatedDir);
run("vp", ["exec", "routa", "check"], authenticatedDir);
run("vp", ["exec", "routa", "build"], authenticatedDir);
checkAuthenticatedOpenApi(authenticatedDir);
const authenticatedServer = await startServer(authenticatedDir);
try {
	await checkAuthentication(authenticatedServer);
} finally {
	await authenticatedServer.stop();
}
process.stdout.write("Packed authenticated consumer passed.\n");

// Request identity through the packed packages: identity-bound redacted sink events in a
// consumer test, then routa start with the default JSON console logger and with logger: false.
// Its src/routa.ts uses the default JSON console logger, or `logger: false` when SMOKE_LOGGER is
// "off", takes correlation from x-correlation-id, and prints what onRequestError receives, so
// the check can read it from the server's output. Its /boom handler fails with error text
// Routa's own logs must not carry.
const identityDir = scaffoldConsumer("app-identity", []);
copyFixture("identity", identityDir);
run("vp", ["exec", "routa", "check"], identityDir);
run("vp", ["exec", "routa", "build"], identityDir);
run("vp", ["run", "test"], identityDir);

for (const [logging, env] of [
	[true, {}],
	[false, { SMOKE_LOGGER: "off" }],
]) {
	const identityServer = await startServer(identityDir, env);
	try {
		await checkIdentity(identityServer, logging);
	} finally {
		await identityServer.stop();
	}
}
process.stdout.write("Packed identity consumer passed.\n");

process.stdout.write(`Pack check passed in ${basename(tmp)}.\n`);

/** Copies a fixture directory into a consumer project, over the files already there. */
function copyFixture(name, appDir) {
	cpSync(join(fixtures, name), appDir, { recursive: true });
}

/** Scaffolds a project from the packed creator and installs the packed packages into it. */
function scaffoldConsumer(name, flags) {
	const appDir = join(tmp, name);
	run(
		"vp",
		[
			"dlx",
			`file:${tarballs.get("create-routa-ts")}`,
			name,
			...flags,
			"--no-git",
			"--no-install",
			"--yes",
		],
		tmp,
	);
	const manifestPath = join(appDir, "package.json");
	const manifest = readJson(manifestPath);
	manifest.dependencies["@routa-ts/core"] = `file:${tarballs.get("@routa-ts/core")}`;
	manifest.dependencies["@routa-ts/cli"] = `file:${tarballs.get("@routa-ts/cli")}`;
	writeFileSync(manifestPath, `${JSON.stringify(manifest, null, "\t")}\n`);
	writeFileSync(
		join(appDir, "pnpm-workspace.yaml"),
		`overrides:\n  "@routa-ts/cli": "file:${tarballs.get("@routa-ts/cli")}"\n  "@routa-ts/core": "file:${tarballs.get("@routa-ts/core")}"\n  "create-routa-ts": "file:${tarballs.get("create-routa-ts")}"\nallowBuilds:\n  esbuild: true\n`,
	);
	run("vp", ["install"], appDir);
	return appDir;
}

/**
 * Starts the packed CLI's `routa start` in `cwd` on a free port and resolves once it serves the
 * starter route. This guards the packaged runtime entry (dist/runtime.js), which `routa check`
 * and `routa build` never exercise.
 *
 * Returns the port; a signal that aborts 30 seconds after the start, the one deadline for
 * readiness and for every request and log wait a check makes; `output()`, what the server has
 * written so far; and `stop()`, which resolves once the server has exited and both of its output
 * streams have ended, and rejects if that takes longer than its bounded waits.
 */
async function startServer(cwd, env = {}) {
	const port = await freePort();
	const signal = AbortSignal.timeout(30_000);
	const cli = join(cwd, "node_modules/@routa-ts/cli");
	const bin = readJson(join(cli, "package.json")).bin.routa;
	// `routa start` runs the runtime in a child process, so the server gets its own process
	// group and stop() signals the whole group.
	const child = spawn(process.execPath, [join(cli, bin), "start"], {
		cwd,
		env: { ...process.env, ...env, PORT: String(port), HOST: "127.0.0.1" },
		stdio: ["ignore", "pipe", "pipe"],
		detached: true,
	});
	let written = "";
	child.stdout.on("data", (chunk) => {
		written += chunk;
	});
	child.stderr.on("data", (chunk) => {
		written += chunk;
	});
	const output = () => written;
	// "close" fires once the process has exited and both of its output streams have ended.
	const closed = new Promise((resolveClosed) => child.once("close", resolveClosed));
	const signalGroup = (name) => {
		try {
			process.kill(-Number(child.pid), name);
		} catch {
			// The server has already exited.
		}
	};
	// The timer is unref'd, so a deadline never keeps pack:check running after the server stops.
	const closedWithin = async (ms) =>
		(await Promise.race([closed, sleep(ms, "timeout", { ref: false })])) !== "timeout";
	let stopping;
	const stop = () => {
		stopping ??= (async () => {
			signalGroup("SIGTERM");

			if (await closedWithin(10_000)) {
				return;
			}

			signalGroup("SIGKILL");

			if (!(await closedWithin(5_000))) {
				// A process that outlived SIGKILL may still hold the pipes open; let go of them so
				// pack:check can exit.
				child.stdout.destroy();
				child.stderr.destroy();
				child.unref();
			}

			throw new Error(`routa start did not stop within 10s of SIGTERM.\n${output()}`);
		})();
		return stopping;
	};

	try {
		while (true) {
			if (child.exitCode !== null) {
				throw new Error(`routa start exited early with code ${child.exitCode}.\n${output()}`);
			}

			if (signal.aborted) {
				throw new Error(`routa start smoke test timed out after 30s.\n${output()}`);
			}

			try {
				const response = await fetch(`http://127.0.0.1:${port}/status`, { signal });
				const body = await response.json();

				if (response.status !== 200 || body.ok !== true) {
					throw new Error(
						`routa start smoke test got ${response.status} ${JSON.stringify(body)}.\n${output()}`,
					);
				}

				break;
			} catch (error) {
				// Until the server listens, fetch throws a TypeError. Once the deadline aborts a
				// request, the next pass reports the timeout.
				if (!(error instanceof TypeError) && !signal.aborted) {
					throw error;
				}
			}

			await sleep(250);
		}
	} catch (error) {
		// Report why the server never served over a failure to stop it.
		await stop().catch(() => {});
		throw error;
	}

	return { port, signal, output, stop };
}

/** Checks the response contract route: header, repeated `Set-Cookie` fields, and an empty body. */
async function checkResponseContract({ port, signal, output }) {
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
			`Response contract smoke test expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}.\n${output()}`,
		);
	}
}

/**
 * Checks the authenticated consumer over HTTP: anonymous, valid, invalid, prioritized, and
 * disallowed credentials, with exact challenges.
 */
async function checkAuthentication({ port, signal, output }) {
	const observe = async (path, headers = {}) => {
		const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers, signal });
		return {
			status: response.status,
			challenge: response.headers.get("www-authenticate"),
			body: await response.text(),
		};
	};
	const bearer = (token) => ({ authorization: `Bearer ${token}` });
	const key = { "x-api-key": "smoke-key" };
	const ok = (body) => ({ status: 200, challenge: null, body });
	const unauthorized = (challenge, kind, title) => ({
		status: 401,
		challenge,
		body: `{"type":"https://routa-ts.dev/problems/${kind}","title":"${title}","status":401}`,
	});
	const required = (challenge) =>
		unauthorized(challenge, "authentication-required", "Authentication required");
	const failed = (challenge) =>
		unauthorized(challenge, "authentication-failed", "Authentication failed");
	const invalidToken = failed('Bearer realm="smoke", error="invalid_token"');
	const user = ok('{"scheme":"userToken","id":"usr_1"}');
	// Each case: path, request headers, expected response, and the authenticators expected to run.
	const cases = {
		"anonymous public": ["/whoami", {}, ok('{"status":"anonymous"}'), []],
		"valid Bearer public": [
			"/whoami",
			bearer("smoke-token"),
			ok('{"status":"authenticated","id":"usr_1"}'),
			["userToken"],
		],
		"invalid Bearer public": ["/whoami", bearer("wrong"), invalidToken, ["userToken"]],
		"anonymous protected": ["/me", {}, required('Bearer realm="smoke", ApiKey'), []],
		"valid Bearer protected": ["/me", bearer("smoke-token"), user, ["userToken"]],
		"invalid Bearer protected": ["/me", bearer("wrong"), invalidToken, ["userToken"]],
		"valid API key protected": [
			"/me",
			key,
			ok('{"scheme":"serviceKey","id":"svc_1"}'),
			["serviceKey"],
		],
		"both credentials select by priority": [
			"/me",
			{ ...bearer("smoke-token"), ...key },
			user,
			["userToken"],
		],
		"a rejected Bearer never falls back to a valid key": [
			"/me",
			{ ...bearer("wrong"), ...key },
			invalidToken,
			["userToken"],
		],
		"disallowed Bearer on a key-only route": ["/keys", bearer("smoke-token"), failed("ApiKey"), []],
		"valid API key on a key-only route": [
			"/keys",
			key,
			ok('{"scheme":"serviceKey"}'),
			["serviceKey"],
		],
	};

	// Clear anything a readiness or earlier request recorded.
	await observe("/calls");

	for (const [name, [path, headers, expected, expectedCalls]] of Object.entries(cases)) {
		const actual = await observe(path, headers);
		const ran = JSON.parse((await observe("/calls")).body).calls;

		if (JSON.stringify(actual) !== JSON.stringify(expected)) {
			throw new Error(
				`Authentication smoke test "${name}" expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}.\n${output()}`,
			);
		}

		if (JSON.stringify(ran) !== JSON.stringify(expectedCalls)) {
			throw new Error(
				`Authentication smoke test "${name}" expected authenticators ${JSON.stringify(expectedCalls)} to run, got ${JSON.stringify(ran)}.\n${output()}`,
			);
		}
	}
}

/**
 * Checks request identity over HTTP: a generated x-request-id that a forged one never replaces,
 * one valid correlation ID echoed and an invalid one dropped, an unexpected failure reported to
 * onRequestError with its original error, and, when logging is on, JSON events that share the
 * identity and carry no error text.
 */
async function checkIdentity({ port, signal, output, stop }, logging) {
	const observe = async (path, headers) => {
		const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers, signal });
		await response.arrayBuffer();
		return {
			status: response.status,
			requestId: response.headers.get("x-request-id"),
			correlationId: response.headers.get("x-correlation-id"),
		};
	};
	const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
	const accepted = await observe("/status", {
		"x-request-id": "forged",
		"X-Correlation-Id": "trace-1",
	});
	const ignored = await observe("/status", { "x-correlation-id": "not valid" });
	const failed = await observe("/boom", { "x-correlation-id": "trace-2" });
	const fail = (problem) => {
		throw new Error(
			`Identity smoke test (logging ${logging ? "on" : "off"}) ${problem}.\n${output()}`,
		);
	};

	const expected = {
		accepted: { status: 200, correlationId: "trace-1" },
		ignored: { status: 200, correlationId: null },
		failed: { status: 500, correlationId: "trace-2" },
	};
	const actual = { accepted, ignored, failed };

	for (const [name, { status, correlationId }] of Object.entries(expected)) {
		const observed = actual[name];

		if (
			observed.status !== status
			|| !uuid.test(observed.requestId ?? "")
			|| observed.correlationId !== correlationId
		) {
			fail(
				`expected ${name} to be ${JSON.stringify(expected[name])} with a UUID, got ${JSON.stringify(observed)}`,
			);
		}
	}

	const lines = () =>
		output()
			.split("\n")
			.flatMap((line) => {
				try {
					return [JSON.parse(line)];
				} catch {
					return [];
				}
			});
	const reported = () =>
		lines().find((line) => line.reported !== undefined && line.requestId === failed.requestId);
	const prepared = () =>
		lines().find(
			(line) =>
				line.event === "http.response.prepared" && line.data?.requestId === accepted.requestId,
		);
	const error = () =>
		lines().find(
			(line) => line.event === "http.error" && line.data?.requestId === failed.requestId,
		);

	if (!logging) {
		// Stop the server and read both streams to their end, so a request event written to
		// either one, as JSON or as plain text, cannot arrive after the check.
		await stop();
		const leaked = output()
			.split("\n")
			.filter((line) => /\bhttp\.[a-z]/.test(line));

		if (leaked.length > 0) {
			fail(`expected logger: false to log no request events, got ${JSON.stringify(leaked)}`);
		}
	} else {
		// The report goes to stderr and the events to stdout, and the two streams arrive
		// independently: wait for all three until the server's deadline.
		while (!signal.aborted && !(reported() && prepared() && error())) {
			await sleep(50);
		}

		if (signal.aborted) {
			fail("timed out waiting for the request report and events");
		}
	}

	if (
		JSON.stringify(reported())
		!== JSON.stringify({
			reported: "unexpected_failure",
			requestId: failed.requestId,
			correlationId: "trace-2",
			original: "db password=identity-smoke-secret rejected",
		})
	) {
		fail(
			`expected onRequestError to receive the original error, got ${JSON.stringify(reported())}`,
		);
	}

	if (!logging) {
		return;
	}

	const events = lines().filter((line) => typeof line.event === "string");

	if (
		prepared()?.level !== "info"
		|| prepared().data.correlationId !== "trace-1"
		|| prepared().data.route !== "/status"
		|| error() === undefined
	) {
		fail(`expected JSON request events that share the identity, got ${JSON.stringify(events)}`);
	}

	expectNoLeak(events, "identity-smoke-secret");
}

/**
 * Generates the authenticated consumer's OpenAPI through the packed CLI and checks its security
 * schemes and each operation's security alternatives, then that `routa openapi check` agrees.
 */
function checkAuthenticatedOpenApi(cwd) {
	run("vp", ["exec", "routa", "openapi", "breaking", "--update-baseline"], cwd);
	const document = readJson(join(cwd, ".routa/openapi-baseline.json"));
	const expected = {
		securitySchemes: {
			serviceKey: { type: "apiKey", in: "header", name: "x-api-key" },
			userToken: { type: "http", scheme: "bearer" },
		},
		"/whoami": [{}, { userToken: [] }, { serviceKey: [] }],
		"/me": [{ userToken: [] }, { serviceKey: [] }],
		"/keys": [{ serviceKey: [] }],
	};
	const actual = {
		securitySchemes: document.components?.securitySchemes,
		...Object.fromEntries(
			["/whoami", "/me", "/keys"].map((path) => [path, document.paths?.[path]?.get?.security]),
		),
	};

	if (canonicalJson(actual) !== canonicalJson(expected)) {
		throw new Error(
			`Authenticated OpenAPI expected ${canonicalJson(expected)}, got ${canonicalJson(actual)}.`,
		);
	}

	run("vp", ["exec", "routa", "openapi", "check"], cwd);
}

/** JSON with object keys sorted, so key order does not matter but array order does. */
function canonicalJson(value) {
	return JSON.stringify(value, (_key, item) =>
		item && typeof item === "object" && !Array.isArray(item)
			? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
			: item,
	);
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
