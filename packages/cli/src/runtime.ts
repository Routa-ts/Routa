#!/usr/bin/env node

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import { createHonoApp, type HonoRoute } from "@routa-ts/core/hono";
import { createLogger } from "@routa-ts/core/logger";
import type { MiddlewareMetadata, RouteMetadata } from "./project.js";

type RoutaConfig = {
	host?: string;
	port?: number;
	logger?: ReturnType<typeof createLogger> | false;
	lifecycleHeaders?: boolean;
};

/**
 * Starts the Routa API server for a working directory.
 *
 * @param cwd - The working directory that contains the Routa project files.
 */
export async function startRuntime(cwd: string, runtimeRoot = cwd): Promise<void> {
	const routes = await loadRoutes(cwd, runtimeRoot);
	const routa = await loadRoutaConfig(cwd, runtimeRoot);
	const logger = routa.logger === false ? undefined : (routa.logger ?? createLogger());
	const app = createHonoApp(routes, { logger, lifecycleHeaders: routa.lifecycleHeaders });
	const hostname = process.env.HOST ?? routa.host ?? "127.0.0.1";
	const port = Number(process.env.PORT ?? routa.port ?? 3000);
	const server = serve({ fetch: app.fetch, hostname, port }, () => {
		logger?.info("api.started", "Routa API started.", {
			host: hostname,
			port,
			routes: routes.length,
		});
	});

	server.once("error", (error) => {
		logger?.error("api.start_failed", "Routa API failed to start.", {
			error: error instanceof Error ? error.message : String(error),
			host: hostname,
			port,
		});
		process.exitCode = 1;
	});
}

/**
 * Loads runtime configuration from `src/routa.ts`.
 *
 * @param cwd - Working directory containing the Routa project
 * @returns The default export from `src/routa.ts`, or an empty object when no default export is provided
 */
async function loadRoutaConfig(cwd: string, runtimeRoot: string): Promise<RoutaConfig> {
	const module = (await import(
		pathToFileURL(runtimePath(cwd, runtimeRoot, "src/routa.ts")).href
	)) as {
		default?: RoutaConfig;
	};

	return module.default ?? {};
}

/**
 * Builds the Hono route list for a project.
 *
 * Loads generated route metadata, imports each route module, and assembles the route contracts with file-level and contract-level middleware.
 *
 * @param cwd - The project working directory
 * @returns The assembled Hono route definitions
 * @throws If a route file does not export a default route config or is missing a required method contract
 */
export async function loadRoutes(cwd: string, runtimeRoot = cwd): Promise<HonoRoute[]> {
	const metadataModule = (await import(
		pathToFileURL(runtimePath(cwd, runtimeRoot, ".routa/routes.gen.ts")).href
	)) as {
		routaRoutes: readonly RouteMetadata[];
	};
	const routes: HonoRoute[] = [];

	for (const route of metadataModule.routaRoutes) {
		const routeModule = (await import(
			pathToFileURL(runtimePath(cwd, runtimeRoot, route.file)).href
		)) as {
			default?: Record<string, HonoRoute["contract"]> & {
				middleware?: readonly NonNullable<HonoRoute["contract"]["middleware"]>[number][];
			};
		};
		const routeConfig = routeModule.default;

		if (!routeConfig) {
			throw new Error(`Route file ${route.file} does not export a default route config.`);
		}

		for (const method of route.methods) {
			const key = method.toLowerCase();
			const contract = routeConfig[key];

			if (!contract) {
				throw new Error(`Route file ${route.file} is missing ${method} contract.`);
			}

			routes.push({
				method: key as HonoRoute["method"],
				path: route.path,
				contract: {
					...contract,
					middleware: [
						// Metadata is loaded from a generated file, so guard shapes written
						// by older generators that omitted middleware fields.
						...(await loadFileMiddleware(
							cwd,
							runtimeRoot,
							route.file,
							route.methodMiddleware?.[key] ?? route.middleware ?? [],
						)),
						...(routeConfig.middleware ?? []),
						...(contract.middleware ?? []),
					],
				},
			});
		}
	}

	return routes;
}

/**
 * Loads middleware contracts referenced by route metadata.
 *
 * @param cwd - The working directory used to resolve middleware files
 * @param routeFile - The current route file to exclude from loading
 * @param metadata - Middleware references to resolve
 * @returns The resolved middleware contracts
 */
async function loadFileMiddleware(
	cwd: string,
	runtimeRoot: string,
	routeFile: string,
	metadata: readonly MiddlewareMetadata[],
): Promise<NonNullable<HonoRoute["contract"]["middleware"]>> {
	const middleware: Array<NonNullable<HonoRoute["contract"]["middleware"]>[number]> = [];

	for (const item of metadata) {
		// Invariant: route-local middleware is already applied via
		// `routeConfig.middleware` / `contract.middleware` in `loadRoutes`.
		// Skip `item.file === routeFile` so those contracts are not imported
		// and stacked a second time.
		if (item.file === routeFile) {
			continue;
		}

		const module = (await import(
			pathToFileURL(runtimePath(cwd, runtimeRoot, item.file)).href
		)) as Record<string, unknown>;
		const contract = module[item.name];

		if (
			!contract
			|| typeof contract !== "object"
			|| Array.isArray(contract)
			|| typeof (contract as { run?: unknown }).run !== "function"
		) {
			throw new Error(`Middleware ${item.name} was not exported by ${item.file}.`);
		}

		middleware.push(contract as NonNullable<HonoRoute["contract"]["middleware"]>[number]);
	}

	return middleware;
}

function runtimePath(cwd: string, runtimeRoot: string, file: string): string {
	const runtimeFile = runtimeRoot === cwd ? file : file.replace(/\.ts$/, ".js");
	return join(runtimeRoot, runtimeFile);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const cwd = process.argv[2] ?? process.cwd();
	const runtimeRoot = process.argv[3] ?? cwd;
	await startRuntime(cwd, runtimeRoot);
}
