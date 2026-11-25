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

/** A consumer test that imports the generated test application module. */
const testAppConsumerTest = `import { expect, it } from "vitest";
import { createTestApp } from "../../../.routa/testing.gen.js";

it("serves GET /status in memory", async () => {
	const app = await createTestApp();

	try {
		const response = await app.request("/status");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });
	} finally {
		await app.dispose();
	}
});
`;

/**
 * A consumer test of the packed public logger: a sink receives redacted events, the default sink
 * writes JSON lines, and TypeScript (through tsc in routa check) rejects a hand-written logger.
 */
const loggerConsumerTest = `import { createLogger, type RoutaLogEvent, type RoutaLogger } from "@routa-ts/core";
import { createLogger as createFromSubpath } from "@routa-ts/core/logger";
import { expect, it, vi } from "vitest";

const ignore = () => undefined;
// Every RoutaLogger member, so the factory brand is the only thing missing.
// @ts-expect-error Routa accepts only loggers that createLogger created.
const handWritten: RoutaLogger = {
	log: ignore,
	trace: ignore,
	debug: ignore,
	info: ignore,
	warn: ignore,
	error: ignore,
	fatal: ignore,
	silent: ignore,
	child: () => handWritten,
	bindings: () => ({}),
	isLevelEnabled: () => true,
};

it("redacts before the sink and writes JSON by default", () => {
	const events: RoutaLogEvent[] = [];
	const body = { user: { email: "ada@example.com" }, tokenCount: 1 };
	const logger: RoutaLogger = createLogger({
		redact: ["user.email"],
		sink: (event) => {
			events.push(event);
		},
	});
	logger.child({ authorization: "Bearer demo" }).info("user.read", "Read\\nuser.", body);

	expect(events[0]?.message).toBe("Read\\\\nuser.");
	expect(events[0]?.data).toEqual({
		authorization: "[Redacted]",
		user: { email: "[Redacted]" },
		tokenCount: 1,
	});
	expect(body.user.email).toBe("ada@example.com");

	const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
	try {
		createFromSubpath().info("app.ready", "Ready.", { password: "hunter2" });
		expect(JSON.parse(String(log.mock.calls[0]?.[0])).data).toEqual({ password: "[Redacted]" });
	} finally {
		log.mockRestore();
	}
	expect(handWritten).toBeDefined();
});
`;

const compiledTestAppCheck = `const { createTestApp } = await import("./dist/.routa/testing.gen.js");
const app = await createTestApp();
const response = await app.request("/status");
const body = await response.json();
await app.dispose();
if (response.status !== 200 || body.ok !== true) {
	throw new Error(\`Compiled test application got \${response.status} \${JSON.stringify(body)}.\`);
}
`;

/**
 * The authenticated consumer's src/routa.ts: one principal schema, a Bearer and an API-key
 * scheme, and a priority that differs from declaration order.
 */
const authenticatedRouta = `import { apiKey, bearer, createRouta } from "@routa-ts/core";
import { z } from "zod";
import { calls } from "./calls.js";

const Principal = z.object({ type: z.enum(["user", "service"]), id: z.string() });

export default createRouta({
	port: 3000,
	authentication: {
		principal: Principal,
		schemes: {
			serviceKey: apiKey({
				header: "x-api-key",
				authenticate: (key) => {
					calls.push("serviceKey");
					return key === "smoke-key"
						? { type: "authenticated", principal: { type: "service", id: "svc_1" } }
						: { type: "rejected" };
				},
			}),
			userToken: bearer({
				challenge: { realm: "smoke" },
				authenticate: (token) => {
					calls.push("userToken");
					return token === "smoke-token"
						? { type: "authenticated", principal: { type: "user", id: "usr_1" } }
						: { type: "rejected" };
				},
			}),
		},
		priority: ["userToken", "serviceKey"],
	},
});
`;

/**
 * Authenticated routes: a public route reading ctx.auth, a protected route, a key-only route,
 * and a smoke-only route that reports, then clears, which authenticators ran.
 */
const authenticatedRoutes = {
	"src/calls.ts": `/** The schemes whose authenticator ran since the last read of /calls. Smoke test only. */
export const calls: string[] = [];
`,
	"src/routes/calls/route.ts": `import { createRoute, createRouteRoot } from "@routa-ts/core";
import { z } from "zod";
import { calls } from "../../calls.js";

export default createRouteRoot("/calls")({
	get: createRoute({
		responses: { success: { status: 200, schema: z.object({ calls: z.array(z.string()) }) } },
		run: () => ({ type: "success", data: { calls: calls.splice(0) } }),
	}),
});
`,
	"src/routes/whoami/route.ts": `import { createRoute, createRouteRoot } from "@routa-ts/core";
import { z } from "zod";

export default createRouteRoot("/whoami")({
	get: createRoute({
		responses: {
			success: { status: 200, schema: z.object({ status: z.string(), id: z.string().optional() }) },
		},
		run: ({ ctx }) => ({
			type: "success",
			data:
				ctx.auth.status === "anonymous"
					? { status: "anonymous" }
					: { status: "authenticated", id: ctx.auth.principal.id },
		}),
	}),
});
`,
	"src/routes/me/route.ts": `import { createRoute, createRouteRoot, requireAuth } from "@routa-ts/core";
import { z } from "zod";

export default createRouteRoot("/me")({
	get: createRoute({
		middleware: [requireAuth()],
		responses: {
			success: {
				status: 200,
				schema: z.object({ scheme: z.enum(["userToken", "serviceKey"]), id: z.string() }),
			},
		},
		// ctx.auth is narrowed to the authenticated branch; tsc in routa check proves it.
		run: ({ ctx }) => ({
			type: "success",
			data: { scheme: ctx.auth.scheme, id: ctx.auth.principal.id },
		}),
	}),
});
`,
	"src/routes/keys/route.ts": `import { createRoute, createRouteRoot, requireAuth } from "@routa-ts/core";
import { z } from "zod";

export default createRouteRoot("/keys")({
	get: createRoute({
		middleware: [requireAuth({ schemes: ["serviceKey"] })],
		responses: {
			success: { status: 200, schema: z.object({ scheme: z.literal("serviceKey") }) },
		},
		run: ({ ctx }) => ({ type: "success", data: { scheme: ctx.auth.scheme } }),
	}),
});
`,
};

/**
 * The identity consumer's src/routa.ts: the default JSON console logger, or `logger: false` when
 * SMOKE_LOGGER is "off", correlation from x-correlation-id, and an onRequestError that prints what
 * it receives, so the smoke test can read it from the server's output.
 */
const identityRouta = `import { createRouta } from "@routa-ts/core";

export default createRouta({
	port: 3000,
	logger: process.env.SMOKE_LOGGER === "off" ? false : undefined,
	correlation: true,
	onRequestError: (error, diagnostic) => {
		console.error(
			JSON.stringify({
				reported: diagnostic.code,
				requestId: diagnostic.requestId,
				correlationId: diagnostic.correlationId,
				original: error instanceof Error ? error.message : String(error),
			}),
		);
	},
});
`;

/** A route whose handler fails unexpectedly, with error text Routa's own logs must not carry. */
const identityFailingRoute = `import { createRoute, createRouteRoot } from "@routa-ts/core";

export default createRouteRoot("/boom")({
	get: createRoute({
		responses: { ok: { status: 200 } },
		run: () => {
			throw new Error("db password=hunter2 rejected");
		},
	}),
});
`;

/**
 * A consumer test of identity through the packed packages: a custom sink receives redacted,
 * identity-bound events, an application without a logger keeps its identity, and the request
 * logger a handler passes on carries correlation while the imported shared logger does not.
 */
const identityConsumerTest = `import { createLogger, createRoute, type RoutaLogEvent, type RoutaLogger } from "@routa-ts/core";
import { createApplication, type HonoRoute } from "@routa-ts/core/hono";
import { expect, it } from "vitest";
import { z } from "zod";

const events: RoutaLogEvent[] = [];
const shared = createLogger({ redact: ["user.email"], sink: (event) => void events.push(event) });

/** An application service that logs through whichever logger its caller passes. */
function lookUp(logger: RoutaLogger) {
	logger.child({ component: "lookup" }).info("lookup.run", "Looked up.", {
		password: "hunter2",
		user: { email: "ada@example.com" },
	});
}

const who: HonoRoute = {
	method: "get",
	path: "/who",
	contract: createRoute({
		responses: { ok: { status: 200, schema: z.object({ requestId: z.string() }) } },
		run: ({ ctx }) => {
			lookUp(ctx.logger);
			lookUp(shared);
			return { type: "ok", data: { requestId: ctx.requestId } };
		},
	}),
};

it("binds request identity to redacted sink events and keeps it without a logger", async () => {
	const app = await createApplication([who], { logger: shared, correlation: true });
	const response = await app.fetch(
		new Request("http://localhost/who", { headers: { "x-correlation-id": "trace-1" } }),
	);
	const requestId = response.headers.get("x-request-id");
	await app.dispose();

	expect(response.headers.get("x-correlation-id")).toBe("trace-1");
	expect(await response.json()).toEqual({ requestId });
	const lookups = events.filter((event) => event.event === "lookup.run");
	expect(lookups.map((event) => event.data)).toEqual([
		{ requestId, correlationId: "trace-1", component: "lookup", password: "[Redacted]", user: { email: "[Redacted]" } },
		{ component: "lookup", password: "[Redacted]", user: { email: "[Redacted]" } },
	]);
	expect(events.find((event) => event.event === "http.response.prepared")?.data).toMatchObject({
		requestId,
		correlationId: "trace-1",
		route: "/who",
		status: 200,
	});

	const quiet = await createApplication([who]);
	const off = await quiet.fetch(new Request("http://localhost/who"));
	await quiet.dispose();
	expect(await off.json()).toEqual({ requestId: off.headers.get("x-request-id") });
	expect(off.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
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
	writeFileSync(join(appDir, "src/routes/status/app.test.ts"), testAppConsumerTest);
	writeFileSync(join(appDir, "src/logger.test.ts"), loggerConsumerTest);
	run("vp", ["exec", "routa", "check"], appDir);

	if (readFileSync(join(appDir, ".routa/testing.gen.ts"), "utf8") !== scaffoldedTesting) {
		throw new Error("routa check rewrote the .routa/testing.gen.ts that create-routa-ts wrote.");
	}

	run("vp", ["exec", "routa", "build"], appDir);
	// The compiled test application module serves a request without a listener.
	run("node", ["--input-type=module", "--eval", compiledTestAppCheck], appDir);
	run("vp", ["run", "test"], appDir);
	run("vp", ["exec", "routa", "openapi", "check"], appDir);
	// The starter has no response headers or cookies, so prove them through the packed
	// packages with one more route after the starter's own checks.
	mkdirSync(join(appDir, "src/routes/session"), { recursive: true });
	writeFileSync(join(appDir, "src/routes/session/route.ts"), responseContractRoute);
	run("vp", ["exec", "routa", "build"], appDir);
	run("vp", ["exec", "routa", "check"], appDir);
	await smokeTestStart(appDir, checkResponseContract);
	process.stdout.write(`Packed consumer passed with zod ${zodVersion} (${label}).\n`);
}

const noOpenApiDir = scaffoldConsumer("app-no-openapi", ["--no-openapi"]);
run("vp", ["exec", "routa", "check"], noOpenApiDir);
run("vp", ["exec", "routa", "build"], noOpenApiDir);
run("vp", ["run", "test"], noOpenApiDir);

// The starter stays authentication-free. A consumer adopts authentication by editing files
// after scaffolding, then routa check (including tsc on the narrowed ctx.auth) and routa start
// prove the packed packages serve the contract.
const authenticatedDir = scaffoldConsumer("app-authenticated", []);
writeFileSync(join(authenticatedDir, "src/routa.ts"), authenticatedRouta);

for (const [file, source] of Object.entries(authenticatedRoutes)) {
	mkdirSync(join(authenticatedDir, file, ".."), { recursive: true });
	writeFileSync(join(authenticatedDir, file), source);
}

run("vp", ["exec", "routa", "check"], authenticatedDir);
run("vp", ["exec", "routa", "build"], authenticatedDir);
checkAuthenticatedOpenApi(authenticatedDir);
await smokeTestStart(authenticatedDir, checkAuthentication);
process.stdout.write("Packed authenticated consumer passed.\n");

// Request identity through the packed packages: identity-bound redacted sink events in a
// consumer test, then routa start with the default JSON console logger and with logger: false.
const identityDir = scaffoldConsumer("app-identity", []);
writeFileSync(join(identityDir, "src/routa.ts"), identityRouta);
mkdirSync(join(identityDir, "src/routes/boom"), { recursive: true });
writeFileSync(join(identityDir, "src/routes/boom/route.ts"), identityFailingRoute);
writeFileSync(join(identityDir, "src/identity.test.ts"), identityConsumerTest);
run("vp", ["exec", "routa", "check"], identityDir);
run("vp", ["exec", "routa", "build"], identityDir);
run("vp", ["run", "test"], identityDir);
await smokeTestStart(identityDir, checkIdentity(true));
await smokeTestStart(identityDir, checkIdentity(false), { SMOKE_LOGGER: "off" });
process.stdout.write("Packed identity consumer passed.\n");

process.stdout.write(`Pack check passed in ${basename(tmp)}.\n`);

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
 * Starts the packaged `routa start` server, waits until it serves the starter route, then runs
 * `check(port, signal, output, logs, stop)` against it, where `logs()` reads the output so far and
 * `stop()` stops the server and resolves once both of its output streams have ended.
 *
 * This guards the packaged runtime entry (dist/runtime.js), which `routa check`
 * and `routa build` never exercise.
 */
async function smokeTestStart(cwd, check, env = {}) {
	const port = await freePort();
	// detached puts the vp -> routa -> node chain in its own process group so
	// the whole tree can be killed once the smoke test finishes.
	const child = spawn("vp", ["exec", "routa", "start"], {
		cwd,
		env: { ...process.env, ...env, PORT: String(port), HOST: "127.0.0.1" },
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
	// "close" fires once the process has exited and both of its output streams have ended.
	const closed = new Promise((resolveClosed) => child.once("close", resolveClosed));
	const signalTree = (signal) => {
		// With shell: true the child is cmd.exe, so stop the whole tree under it, which Windows
		// does only by force.
		if (process.platform === "win32" && child.pid) {
			spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
			return;
		}

		if (child.pid) {
			try {
				process.kill(-child.pid, signal);
				return;
			} catch {
				// Fall back to the direct child below.
			}
		}

		child.kill(signal);
	};
	let stopping;
	const stop = () => {
		stopping ??= (async () => {
			signalTree("SIGTERM");
			// Unref'd, so the deadline never keeps pack:check running after the server has stopped.
			const timeout = sleep(10_000, undefined, { ref: false }).then(() => "timeout");

			if ((await Promise.race([closed, timeout])) === "timeout") {
				signalTree("SIGKILL");
				throw new Error(`routa start did not stop within 10s of SIGTERM.\n${output}`);
			}
		})();
		return stopping;
	};

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

					break;
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

		// Outside the readiness retries: a failing check reports its own error, never a timeout.
		await check(
			port,
			AbortSignal.timeout(Math.max(1, deadline - Date.now())),
			output,
			() => output,
			stop,
		);
	} catch (error) {
		// Stop the server either way, but report the check's failure over a failure to stop.
		await stop().catch(() => {});
		throw error;
	}

	await stop();
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

/**
 * Checks the authenticated consumer over HTTP: anonymous, valid, invalid, prioritized, and
 * disallowed credentials, with exact challenges.
 */
async function checkAuthentication(port, signal, output) {
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
				`Authentication smoke test "${name}" expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}.\n${output}`,
			);
		}

		if (JSON.stringify(ran) !== JSON.stringify(expectedCalls)) {
			throw new Error(
				`Authentication smoke test "${name}" expected authenticators ${JSON.stringify(expectedCalls)} to run, got ${JSON.stringify(ran)}.\n${output}`,
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
function checkIdentity(logging) {
	return async (port, signal, _output, logs, stop) => {
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
				`Identity smoke test (logging ${logging ? "on" : "off"}) ${problem}.\n${logs()}`,
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
			logs()
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
			const leaked = logs()
				.split("\n")
				.filter((line) => /\bhttp\.[a-z]/.test(line));

			if (leaked.length > 0) {
				fail(`expected logger: false to log no request events, got ${JSON.stringify(leaked)}`);
			}
		} else {
			// The report goes to stderr and the events to stdout, and the two streams arrive
			// independently: wait for all three, and fail if any is missing after five seconds.
			const deadline = Date.now() + 5_000;

			while (!(reported() && prepared() && error()) && Date.now() < deadline) {
				await sleep(50);
			}
		}

		if (
			JSON.stringify(reported())
			!== JSON.stringify({
				reported: "unexpected_failure",
				requestId: failed.requestId,
				correlationId: "trace-2",
				original: "db password=hunter2 rejected",
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
			|| JSON.stringify(events).includes("hunter2")
		) {
			fail(`expected JSON request events that share the identity, got ${JSON.stringify(events)}`);
		}
	};
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
