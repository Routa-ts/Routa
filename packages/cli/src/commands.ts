import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
	ambiguousCredentialsDescription,
	type AuthenticationMetadata,
	authenticationFailedDescription,
	rejectsAmbiguousCredentials,
} from "./authentication.js";
import { compareText } from "./compare-text.js";
import {
	formatDiagnostics,
	type MiddlewareMetadata,
	type MiddlewareRejectMetadata,
	type RouteMetadata,
	type RouteMethodInputMetadata,
	validateProject,
} from "./project.js";
import { isRouteFile, routePathForFile, routesRoot, walk } from "./route-discovery.js";
import { runTypeScript } from "./typescript-runner.js";

const devPollMs = 300;
const devRestartDebounceMs = 150;

const emptyRouteInputs: RouteMethodInputMetadata = {
	params: false,
	query: false,
	headers: false,
	cookies: false,
	body: false,
};
function routeStubSource(path: string): string {
	return `import { createRoute, createRouteRoot } from "@routa-ts/core";

const route = createRouteRoot(${JSON.stringify(path)});

export default route({
\tget: createRoute({
\t\tresponses: {},
\t\trun: () => {
\t\t\treturn { type: "success", data: null };
\t\t},
\t}),
});
`;
}

/**
 * Runs project validation and a TypeScript no-emit check.
 *
 * @returns A result object containing the exit code and any captured output.
 */
export function runProjectCheck(cwd = process.cwd()): {
	code: number;
	stdout?: string | undefined;
	stderr?: string | undefined;
} {
	const validation = validateProject(cwd);
	const warnings = validation.warnings.length > 0 ? [formatDiagnostics(validation.warnings)] : [];

	if (validation.diagnostics.length > 0) {
		return {
			code: 1,
			stderr: [formatDiagnostics(validation.diagnostics), ...warnings].join("\n"),
		};
	}

	const stdout = [
		`Routa validation passed for ${validation.routes.length} route file(s).`,
		"Running TypeScript check: tsc -p tsconfig.json --noEmit",
	];
	const typecheck = runTypeScript(cwd, ["-p", "tsconfig.json", "--noEmit"]);

	if (typecheck.code !== 0) {
		return {
			code: typecheck.code,
			stdout: appendOutput(stdout, typecheck.stdout),
			stderr: appendOutput([...warnings, "TypeScript check failed."], typecheck.stderr),
		};
	}

	return {
		code: 0,
		stdout: appendOutput([...stdout, "TypeScript check passed.", "Routa check passed."]),
		...(warnings.length > 0 ? { stderr: appendOutput(warnings) } : {}),
	};
}

/**
 * Validates a Routa project and writes its generated route metadata.
 *
 * @returns A result object containing the exit code and any generation output.
 */
export function runProjectGenerate(cwd = process.cwd()): {
	code: number;
	stdout?: string | undefined;
	stderr?: string | undefined;
} {
	const validation = validateProject(cwd);

	if (validation.diagnostics.length > 0) {
		return {
			code: 1,
			stderr: formatDiagnostics(validation.diagnostics),
		};
	}

	return {
		code: 0,
		stdout: `Generated .routa/routes.gen.ts and .routa/testing.gen.ts for ${validation.routes.length} route file(s).\n`,
	};
}

/**
 * Builds a Routa project after validating its routes.
 *
 * @returns Build output. On success, `stdout` reports how many route files passed validation and build.
 */
export function runProjectBuild(cwd = process.cwd()): {
	code: number;
	stdout?: string | undefined;
	stderr?: string | undefined;
} {
	const validation = validateProject(cwd);

	if (validation.diagnostics.length > 0) {
		return {
			code: 1,
			stderr: formatDiagnostics(validation.diagnostics),
		};
	}

	const build = runTypeScript(cwd, ["-p", "tsconfig.json"]);

	if (build.code !== 0) {
		return build;
	}

	return { code: 0, stdout: `Routa build passed for ${validation.routes.length} route file(s).\n` };
}

/**
 * Prints a route reference from Routa's validated route metadata.
 *
 * @param argv - Command-line arguments for route reference formatting
 * @param cwd - Project root directory
 * @returns The formatted route reference or validation/argument diagnostics
 */
export function runProjectRoutes(
	argv: readonly string[] = [],
	cwd = process.cwd(),
): { code: number; stdout?: string | undefined; stderr?: string | undefined } {
	const format = routeReferenceFormat(argv);

	if (!format) {
		return {
			code: 1,
			stderr: "Invalid routes format. Use --format json or --format markdown.\n",
		};
	}

	const validation = validateProject(cwd);

	if (validation.diagnostics.length > 0) {
		return {
			code: 1,
			stderr: formatDiagnostics(validation.diagnostics),
		};
	}

	return {
		code: 0,
		stdout:
			format === "json"
				? `${JSON.stringify(routeReference(validation.routes, validation.authentication), null, "\t")}\n`
				: routeReferenceMarkdown(validation.routes, validation.authentication),
	};
}

/**
 * Runs the Routa project in dev mode.
 *
 * @param argv - Command-line arguments to pass to the server launcher
 * @param cwd - Project root directory
 * @returns The process result, including an exit code and any captured output
 */
export function runProjectDev(
	argv: readonly string[] = [],
	cwd = process.cwd(),
): { code: number; stdout?: string | undefined; stderr?: string | undefined } {
	return runProjectServer("dev", argv, cwd);
}

/**
 * Starts the Routa development supervisor.
 *
 * Prepares the dev runtime, writes any preparation output to the console on failure or when printing the runtime command, and then supervises the runtime process for source changes.
 *
 * @param argv - Command-line arguments to pass to the dev server
 * @param cwd - Project root directory
 */
export function runProjectDevProcess(argv: readonly string[] = [], cwd = process.cwd()): void {
	const result = prepareProjectServer("dev", argv, cwd);

	if (result.code !== 0 || result.print) {
		writeCommandResult(result);
		process.exitCode = result.code;
		return;
	}

	runDevSupervisor(cwd, result.runtimeFile);
}

/**
 * Starts the Routa project server.
 *
 * @param argv - Command-line arguments to pass to the server preparation step
 * @param cwd - The project working directory
 * @returns The command result with an exit code and optional output
 */
export function runProjectStart(
	argv: readonly string[] = [],
	cwd = process.cwd(),
): { code: number; stdout?: string | undefined; stderr?: string | undefined } {
	return runProjectServer("start", argv, cwd);
}

/**
 * Prepares and launches the project runtime for development or production start.
 *
 * @param mode - The server mode to prepare.
 * @param argv - Command-line arguments to pass to server preparation.
 * @param cwd - The working directory of the project.
 * @returns The preparation result, or the spawned process result code.
 */
function runProjectServer(
	mode: "dev" | "start",
	argv: readonly string[],
	cwd: string,
): { code: number; stdout?: string | undefined; stderr?: string | undefined } {
	const result = prepareProjectServer(mode, argv, cwd);

	if (result.code !== 0 || result.print) {
		return result;
	}

	const server = spawnSync(
		process.execPath,
		runtimeArgs(result.runtimeFile, cwd, result.runtimeRoot, result.useTsx, mode),
		{
			cwd,
			encoding: "utf8",
			stdio: "inherit",
		},
	);

	return { code: server.status ?? 1 };
}

type PreparedServer = {
	code: number;
	stdout?: string | undefined;
	stderr?: string | undefined;
	runtimeFile: string;
	runtimeRoot: string;
	useTsx: boolean;
	print: boolean;
};

/**
 * Prepares a project server launch or dev-supervision run.
 *
 * In dev mode, empty route files are stubbed before validation. If validation fails, the returned result
 * contains the formatted diagnostics. Otherwise, the runtime file is resolved and the project is
 * type-checked before the server can start.
 *
 * @param mode - The server mode to prepare.
 * @param argv - Command-line arguments passed to the server command.
 * @param cwd - The project root directory.
 * @returns The prepared server result, including the runtime file path when preparation succeeds.
 */
function prepareProjectServer(
	mode: "dev" | "start",
	argv: readonly string[],
	cwd: string,
): PreparedServer {
	if (mode === "dev") {
		stubEmptyRouteFiles(cwd);
	}

	const validation = validateProject(cwd);

	if (validation.diagnostics.length > 0) {
		return {
			code: 1,
			stderr: formatDiagnostics(validation.diagnostics),
			runtimeFile: "",
			runtimeRoot: "",
			useTsx: false,
			print: false,
		};
	}

	const runtimeFile = join(dirname(fileURLToPath(import.meta.url)), "runtime.js");
	const runtimeRoot = mode === "start" ? join(cwd, "dist") : cwd;
	const useTsx = mode === "dev";
	const runtimeOutputError =
		mode === "start" ? validateRuntimeOutput(cwd, runtimeRoot, validation.routes) : undefined;

	if (runtimeOutputError) {
		return {
			code: 1,
			stderr: `${runtimeOutputError}\n`,
			runtimeFile,
			runtimeRoot,
			useTsx,
			print: false,
		};
	}

	if (argv.includes("--print")) {
		return { code: 0, stdout: `${runtimeFile}\n`, runtimeFile, runtimeRoot, useTsx, print: true };
	}

	if (mode === "start") {
		return { code: 0, runtimeFile, runtimeRoot, useTsx, print: false };
	}

	const typecheck = runTypeScript(cwd, ["-p", "tsconfig.json", "--noEmit"]);
	if (typecheck.code !== 0) {
		return {
			...typecheck,
			runtimeFile,
			runtimeRoot,
			useTsx,
			print: false,
		};
	}

	return { code: 0, runtimeFile, runtimeRoot, useTsx, print: false };
}

function validateRuntimeOutput(
	cwd: string,
	runtimeRoot: string,
	routes: readonly RouteMetadata[],
): string | undefined {
	const runtimeFiles = new Set(["src/routa.ts", ".routa/routes.gen.ts"]);

	for (const route of routes) {
		runtimeFiles.add(route.file);
		const schemaFile = join(dirname(route.file), "schemas.ts");
		if (existsSync(join(cwd, schemaFile))) {
			runtimeFiles.add(schemaFile);
		}
		for (const middleware of route.middleware) {
			runtimeFiles.add(middleware.file);
		}
		for (const middlewareList of Object.values(route.methodMiddleware)) {
			for (const middleware of middlewareList) {
				runtimeFiles.add(middleware.file);
			}
		}
		for (const file of route.middlewareFiles ?? []) {
			runtimeFiles.add(file);
		}
	}

	for (const file of runtimeFiles) {
		const sourceFile = join(cwd, file);
		const outputFile = join(runtimeRoot, file.replace(/\.ts$/, ".js"));

		if (!existsSync(outputFile)) {
			return `Missing compiled runtime output for ${file}. Run routa build first.`;
		}

		if (statSync(outputFile).mtimeMs < statSync(sourceFile).mtimeMs) {
			return `Compiled runtime output for ${file} is stale. Run routa build first.`;
		}
	}

	return undefined;
}

/**
 * Writes captured output to the process streams.
 *
 * @param result - The command output to write.
 */
function writeCommandResult(result: {
	stdout?: string | undefined;
	stderr?: string | undefined;
}): void {
	if (result.stdout) {
		process.stdout.write(result.stdout);
	}

	if (result.stderr) {
		process.stderr.write(result.stderr);
	}
}

/**
 * Builds the command-line arguments for launching the Routa runtime.
 *
 * @param runtimeFile - The runtime script to execute
 * @param cwd - The project directory passed to the runtime
 * @param runtimeRoot - The source or compiled project root passed to the runtime
 * @param useTsx - Whether Node should load the TypeScript runtime hook
 * @param mode - The explicit command mode passed to the runtime
 * @returns The argument list for the Node process
 */
export function runtimeArgs(
	runtimeFile: string,
	cwd: string,
	runtimeRoot: string,
	useTsx: boolean,
	mode: "dev" | "start",
): string[] {
	return [...(useTsx ? ["--import", "tsx"] : []), runtimeFile, cwd, runtimeRoot, mode];
}

/**
 * Supervises the Routa dev runtime and restarts it when source files change.
 *
 * Re-stubs empty route files before each validation, reports validation diagnostics, and exits cleanly on termination signals.
 * Restarts are debounced and wait for the previous child process to exit before respawning.
 */
function runDevSupervisor(cwd: string, runtimeFile: string): void {
	let child = startRuntimeProcess(cwd, runtimeFile);
	let snapshot = sourceSnapshot(cwd);
	let restartTimer: ReturnType<typeof setTimeout> | undefined;
	let restarting = false;
	let restartQueued = false;

	const restart = async () => {
		if (restarting) {
			restartQueued = true;
			return;
		}

		restarting = true;

		try {
			do {
				restartQueued = false;
				const nextSnapshot = sourceSnapshot(cwd);

				if (!sourceSnapshotChanged(snapshot, nextSnapshot)) {
					continue;
				}

				for (const file of stubEmptyRouteFiles(cwd)) {
					process.stdout.write(`Stubbed ${file}\n`);
				}

				const validation = validateProject(cwd);

				if (validation.diagnostics.length > 0) {
					process.stderr.write(formatDiagnostics(validation.diagnostics));
					snapshot = sourceSnapshot(cwd);
					continue;
				}

				process.stdout.write("Restarting Routa dev server...\n");
				const previous = child;
				previous.kill();
				await waitForChildExit(previous);
				child = startRuntimeProcess(cwd, runtimeFile);
				snapshot = sourceSnapshot(cwd);
			} while (restartQueued);
		} finally {
			restarting = false;
		}
	};

	const scheduleRestart = () => {
		if (!sourceSnapshotChanged(snapshot, sourceSnapshot(cwd))) {
			return;
		}

		if (restartTimer) {
			clearTimeout(restartTimer);
		}

		restartTimer = setTimeout(() => {
			restartTimer = undefined;
			void restart();
		}, devRestartDebounceMs);
	};

	const timer = setInterval(scheduleRestart, devPollMs);
	const stop = () => {
		clearInterval(timer);
		if (restartTimer) {
			clearTimeout(restartTimer);
		}
		child.kill();
		process.exit(0);
	};

	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);
}

/**
 * Resolves when a child process has exited.
 */
function waitForChildExit(child: ChildProcess): Promise<void> {
	if (child.exitCode !== null || child.signalCode !== null) {
		return Promise.resolve();
	}

	return new Promise((resolve) => {
		child.once("exit", () => resolve());
	});
}

/**
 * Starts the Routa runtime process.
 *
 * @param cwd - Working directory for the spawned process
 * @param runtimeFile - Path to the generated runtime entry file
 * @returns The spawned child process
 */
function startRuntimeProcess(cwd: string, runtimeFile: string): ChildProcess {
	return spawn(process.execPath, runtimeArgs(runtimeFile, cwd, cwd, true, "dev"), {
		cwd,
		stdio: "inherit",
	});
}

export type SourceSnapshot = Map<string, number>;

/**
 * Replaces empty route files with the default route stub.
 *
 * @param cwd - Project root directory
 * @returns The relative paths of the files that were written
 */
export function stubEmptyRouteFiles(cwd = process.cwd()): string[] {
	const routesDir = join(cwd, routesRoot);

	if (!existsSync(routesDir)) {
		return [];
	}

	const files = walk(routesDir).filter(isRouteFile);
	const written: string[] = [];

	for (const file of files) {
		const content = readFileSync(file, "utf8");

		if (content.trim() !== "") {
			continue;
		}

		writeFileSync(file, routeStubSource(routePathForFile(routesDir, file)));
		written.push(relative(cwd, file));
	}

	return written;
}

/**
 * Captures modification times for Routa source files.
 *
 * @returns A map of file paths relative to `cwd` to their last modification time in milliseconds.
 */
export function sourceSnapshot(cwd = process.cwd()): SourceSnapshot {
	const files = [
		...walk(join(cwd, "src")).filter((file) => file.endsWith(".ts")),
		join(cwd, ".routa/routes.gen.ts"),
	].filter((file) => existsSync(file));
	const snapshot: SourceSnapshot = new Map();

	for (const file of files) {
		snapshot.set(relative(cwd, file), statSync(file).mtimeMs);
	}

	return snapshot;
}

/**
 * Detects whether two source snapshots differ.
 *
 * @param previous - The earlier snapshot
 * @param next - The later snapshot
 * @returns `true` if the snapshots differ, `false` otherwise.
 */
export function sourceSnapshotChanged(previous: SourceSnapshot, next: SourceSnapshot): boolean {
	if (previous.size !== next.size) {
		return true;
	}

	for (const [file, mtime] of next) {
		if (previous.get(file) !== mtime) {
			return true;
		}
	}

	return false;
}

type RouteReferenceFormat = "json" | "markdown";

type RouteReference = {
	routes: RouteReferenceRoute[];
};

type RouteReferenceRoute = {
	path: string;
	file: string;
	groups: string[];
	segments: string[];
	methods: RouteReferenceMethod[];
};

type RouteReferenceMethod = {
	method: string;
	inputs: RouteMethodInputMetadata;
	responses: number[];
	ctx: string[];
	rejects: MiddlewareRejectMetadata[];
	middleware: Array<
		Pick<MiddlewareMetadata, "file" | "name" | "requires" | "provides" | "rejects">
	>;
};

/**
 * Reads the requested route reference output format from CLI arguments.
 *
 * @param argv - Command-line arguments after `routes`
 * @returns The requested format, or `undefined` when the format is invalid
 */
function routeReferenceFormat(argv: readonly string[]): RouteReferenceFormat | undefined {
	const formatArg = argv.find((item) => item.startsWith("--format"));

	if (!formatArg) {
		return "markdown";
	}

	const value = formatArg.includes("=")
		? formatArg.slice(formatArg.indexOf("=") + 1)
		: argv[argv.indexOf(formatArg) + 1];

	return value === "json" || value === "markdown" ? value : undefined;
}

/**
 * Projects route metadata into a public route reference shape.
 *
 * @param routes - Validated route metadata
 * @returns Route reference data suitable for JSON or Markdown rendering
 */
function routeReference(
	routes: readonly RouteMetadata[],
	authentication: AuthenticationMetadata | undefined,
): RouteReference {
	return {
		routes: [...routes]
			.sort(
				(left, right) => compareText(left.path, right.path) || compareText(left.file, right.file),
			)
			.map((route) => ({
				path: route.path,
				file: route.file,
				groups: route.groups,
				segments: route.segments,
				methods: [...route.methods]
					.sort(compareText)
					.map((method) => routeReferenceMethod(route, method, authentication)),
			})),
	};
}

/**
 * Builds a method-level route reference entry.
 *
 * @param route - Route metadata that owns the method
 * @param method - Uppercase HTTP method name
 * @returns Method metadata with resolved middleware, context, rejects, inputs, and responses
 */
function routeReferenceMethod(
	route: RouteMetadata,
	method: string,
	authentication: AuthenticationMetadata | undefined,
): RouteReferenceMethod {
	const key = method.toLowerCase();
	const middleware = route.methodMiddleware[key] ?? route.middleware;
	const ctx = Array.from(new Set(middleware.flatMap((item) => item.provides))).sort();
	const rejects = uniqueRejects([
		...(authentication
			? [
					{
						type: "authenticationFailed",
						status: 401,
						description: authenticationFailedDescription,
					},
				]
			: []),
		...(rejectsAmbiguousCredentials(middleware, authentication)
			? [
					{
						type: "ambiguousCredentials",
						status: 400,
						description: ambiguousCredentialsDescription,
					},
				]
			: []),
		...middleware.flatMap((item) => item.rejects),
	]);

	return {
		method,
		inputs: route.inputs[key] ?? { ...emptyRouteInputs },
		responses: [...(route.responses[key] ?? [])].sort((left, right) => left - right),
		ctx,
		rejects,
		middleware: middleware.map((item) => ({
			file: item.file,
			name: item.name,
			requires: item.requires,
			provides: item.provides,
			rejects: item.rejects,
		})),
	};
}

/**
 * Renders validated route metadata as a Markdown route reference.
 *
 * @param routes - Validated route metadata
 * @returns Markdown route reference
 */
function routeReferenceMarkdown(
	routes: readonly RouteMetadata[],
	authentication: AuthenticationMetadata | undefined,
): string {
	const reference = routeReference(routes, authentication);
	const lines = ["# Routa Route Reference", ""];

	if (reference.routes.length === 0) {
		lines.push("No routes found.", "");
		return lines.join("\n");
	}

	for (const route of reference.routes) {
		lines.push(`## ${route.path}`, "", `File: \`${route.file}\``);

		if (route.groups.length > 0) {
			lines.push(`Groups: ${route.groups.map((item) => `\`${item}\``).join(", ")}`);
		}

		if (route.segments.length > 0) {
			lines.push(`Segments: ${route.segments.map((item) => `\`${item}\``).join(", ")}`);
		}

		lines.push("");

		for (const method of route.methods) {
			lines.push(
				`### ${method.method}`,
				"",
				`Inputs: ${inputList(method.inputs).join(", ") || "none"}`,
				`Responses: ${method.responses.join(", ") || "none"}`,
				`Context: ${method.ctx.map((item) => `\`ctx.${item}\``).join(", ") || "none"}`,
				`Rejects: ${method.rejects.map((item) => `\`${item.type}\` (${item.status})`).join(", ") || "none"}`,
				"",
				"Middleware:",
			);

			if (method.middleware.length === 0) {
				lines.push("- none");
			} else {
				for (const middleware of method.middleware) {
					lines.push(
						`- \`${middleware.name}\` from \`${middleware.file}\``
							+ `; requires: ${middleware.requires.join(", ") || "none"}`
							+ `; provides: ${middleware.provides.join(", ") || "none"}`
							+ `; rejects: ${middleware.rejects.map((item) => `${item.type}:${item.status}`).join(", ") || "none"}`,
					);
				}
			}

			lines.push("");
		}
	}

	return `${lines.join("\n")}\n`;
}

/**
 * Converts input metadata into a compact list of declared input locations.
 *
 * @param inputs - Route method input metadata
 * @returns Declared input location names
 */
function inputList(inputs: RouteMethodInputMetadata): string[] {
	return (["params", "query", "headers", "cookies", "body"] as const).filter((key) => inputs[key]);
}

function uniqueRejects(rejects: readonly MiddlewareRejectMetadata[]): MiddlewareRejectMetadata[] {
	const unique = new Map<string, MiddlewareRejectMetadata>();

	for (const reject of rejects) {
		unique.set(reject.type, reject);
	}

	return Array.from(unique.values()).sort((left, right) => compareText(left.type, right.type));
}

/**
 * Appends captured output to a list of lines.
 *
 * @param lines - The lines to join.
 * @param output - Additional output to append after the joined lines.
 * @returns The combined text with a trailing newline.
 */
function appendOutput(lines: string[], output?: string): string {
	const base = `${lines.join("\n")}\n`;

	if (!output) {
		return base;
	}

	return `${base}${output.endsWith("\n") ? output : `${output}\n`}`;
}
