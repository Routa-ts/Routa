#!/usr/bin/env node

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import {
	createProjectApplication as createApplicationFromModules,
	type ProjectApplication,
} from "@routa-ts/core/hono";

type RuntimeMode = "dev" | "start";

/**
 * Starts the Routa API server for a working directory.
 *
 * Application services are constructed before the server listens. When the listener fails to
 * start, the services are released and the listener failure stays the reported error.
 *
 * @param cwd - The working directory that contains the Routa project files.
 * @param runtimeRoot - The directory containing source or compiled runtime modules.
 * @param runtimeMode - The explicit `dev` or `start` command mode.
 * @throws When the services factory fails, or the listen options are invalid
 */
export async function startRuntime(
	cwd: string,
	runtimeRoot: string,
	runtimeMode: RuntimeMode,
): Promise<void> {
	const { application, config, logger, routes } = await createProjectApplication(
		cwd,
		runtimeRoot,
		runtimeMode,
	);
	const hostname = process.env.HOST ?? config.host ?? "127.0.0.1";
	const port = Number(process.env.PORT ?? config.port ?? 3000);
	// No request was accepted when the listener fails, so the services can be released at once.
	const release = () =>
		application.dispose().catch((cleanupError: unknown) => {
			logger?.error("services.cleanup_failed", "Application service cleanup failed.", {
				failures: (cleanupError instanceof AggregateError
					? cleanupError.errors
					: [cleanupError]
				).map((failure: unknown) => (failure instanceof Error ? failure.message : String(failure))),
			});
		});
	let server: ReturnType<typeof serve>;

	try {
		server = serve({ fetch: application.fetch, hostname, port }, () => {
			logger?.info("api.started", "Routa API started.", {
				host: hostname,
				port,
				routes: routes.length,
			});
		});
	} catch (error) {
		// An invalid listen option, such as a port out of range, throws before listening.
		await release();
		throw error;
	}

	server.once("error", (error) => {
		logger?.error("api.start_failed", "Routa API failed to start.", {
			error: error instanceof Error ? error.message : String(error),
			host: hostname,
			port,
		});
		process.exitCode = 1;
		void release();
	});
}

/**
 * Builds a project's application instance without listening, importing its modules from
 * `runtimeRoot`.
 *
 * @param cwd - The working directory that contains the Routa project files.
 * @param runtimeRoot - The directory containing source or compiled runtime modules.
 * @param runtimeMode - The explicit `dev` or `start` command mode.
 * @throws When a route file, `src/routa.ts`, and the generated metadata disagree, or when the
 *   services factory fails
 */
export function createProjectApplication(
	cwd: string,
	runtimeRoot: string,
	runtimeMode: RuntimeMode,
): Promise<ProjectApplication> {
	return createApplicationFromModules(
		(file) => import(pathToFileURL(runtimePath(cwd, runtimeRoot, file)).href),
		{ runtimeMode },
	);
}

function runtimePath(cwd: string, runtimeRoot: string, file: string): string {
	const runtimeFile = runtimeRoot === cwd ? file : file.replace(/\.ts$/, ".js");
	return join(runtimeRoot, runtimeFile);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const cwd = process.argv[2] ?? process.cwd();
	const runtimeRoot = process.argv[3] ?? cwd;
	const runtimeMode = process.argv[4];

	if (runtimeMode !== "dev" && runtimeMode !== "start") {
		throw new Error('Routa runtime mode must be explicitly set to "dev" or "start".');
	}

	await startRuntime(cwd, runtimeRoot, runtimeMode);
}
