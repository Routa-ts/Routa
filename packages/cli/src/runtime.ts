#!/usr/bin/env node

import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { serve } from "@hono/node-server";
import {
	type ApplicationServicesDeclaration,
	createApplication,
	type HonoRoute,
	type RoutaApplication,
} from "@routa-ts/core/hono";
import { createLogger } from "@routa-ts/core/logger";
import type { MiddlewareMetadata, RouteMetadata } from "./project.js";

type RoutaLogger = ReturnType<typeof createLogger>;

type RoutaConfig = {
	host?: string;
	port?: number;
	logger?: RoutaLogger | false;
	lifecycleHeaders?: boolean;
	responseValidation?: "development" | "always";
	services?: unknown;
};

type RuntimeMode = "dev" | "start";

type MetadataModule = {
	routaRoutes: readonly RouteMetadata[];
	routaApplicationServices?: readonly string[];
};

/** A project's application instance, with the configuration and logger it was built from. */
export type ProjectApplication = {
	application: RoutaApplication;
	config: RoutaConfig;
	logger: RoutaLogger | undefined;
	routes: readonly HonoRoute[];
};

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
 * Builds a project's application instance without listening: it loads the generated route
 * metadata, route modules, and `src/routa.ts`, then constructs the application services.
 *
 * @param cwd - The working directory that contains the Routa project files.
 * @param runtimeRoot - The directory containing source or compiled runtime modules.
 * @param runtimeMode - The explicit `dev` or `start` command mode.
 * @throws When `src/routa.ts` and the generated metadata disagree about application services,
 *   or when the services factory fails
 */
export async function createProjectApplication(
	cwd: string,
	runtimeRoot: string,
	runtimeMode: RuntimeMode,
): Promise<ProjectApplication> {
	const routes = await loadRoutes(cwd, runtimeRoot);
	const metadata = await loadMetadata(cwd, runtimeRoot);
	const config = await loadRoutaConfig(cwd, runtimeRoot);
	const logger = config.logger === false ? undefined : (config.logger ?? createLogger());
	const services = pairServices(config.services, metadata.routaApplicationServices, {
		file: "src/routa.ts",
		scope: "application services",
		declare: "Declare services in the createRouta object with defineServices<Contract>()",
	});
	const application = await createApplication(routes, {
		runtimeMode,
		...(logger && { logger }),
		...(config.lifecycleHeaders !== undefined && { lifecycleHeaders: config.lifecycleHeaders }),
		...(config.responseValidation && { responseValidation: config.responseValidation }),
		...(services && { services: services as ApplicationServicesDeclaration }),
	});

	return { application, config, logger, routes };
}

/**
 * Pairs a configured services factory with the names `routa generate` read for its contract.
 *
 * @param where - The module that configures the factory, the scope's name in messages, and how
 *   to declare it
 * @throws When only one side declares the services, or `services` is not a function
 */
function pairServices(
	factory: unknown,
	names: readonly string[] | undefined,
	where: { file: string; scope: string; declare: string },
): { factory: (context: never) => unknown; names: readonly string[] } | undefined {
	if (factory === undefined) {
		if (names) {
			throw new Error(
				`.routa/routes.gen.ts declares ${where.scope}, but ${where.file} configures none. Run routa generate.`,
			);
		}

		return undefined;
	}

	const configured = where.scope === "application services" ? "services" : where.scope;

	if (typeof factory !== "function") {
		throw new TypeError(
			`${where.file} configures ${configured} that are not a factory. ${where.declare}.`,
		);
	}

	if (!names) {
		throw new Error(
			`${where.file} configures ${configured} that routa generate could not read from source, so Routa cannot check them. ${where.declare}, then run routa generate.`,
		);
	}

	return { factory: factory as (context: never) => unknown, names };
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
	const metadataModule = await loadMetadata(cwd, runtimeRoot);
	const routes: HonoRoute[] = [];

	for (const route of metadataModule.routaRoutes) {
		const routeModule = (await import(
			pathToFileURL(runtimePath(cwd, runtimeRoot, route.file)).href
		)) as {
			default?: Record<string, HonoRoute["contract"]> & {
				middleware?: readonly NonNullable<HonoRoute["contract"]["middleware"]>[number][];
				services?: unknown;
			};
		};
		const routeConfig = routeModule.default;

		if (!routeConfig) {
			throw new Error(`Route file ${route.file} does not export a default route config.`);
		}

		const routeFileServices = pairServices(routeConfig.services, route.services?.routeFile?.names, {
			file: route.file,
			scope: "route-file services",
			declare: "Declare them on the route root with defineServices<Contract>()",
		});

		for (const method of route.methods) {
			const key = method.toLowerCase();
			const contract = routeConfig[key];

			if (!contract) {
				throw new Error(`Route file ${route.file} is missing ${method} contract.`);
			}

			// Metadata is loaded from a generated file, so guard shapes written
			// by older generators that omitted middleware fields.
			const chainMetadata = route.methodMiddleware?.[key] ?? route.middleware ?? [];
			const fileMiddleware = await loadFileMiddleware(cwd, runtimeRoot, route.file, chainMetadata);
			const routeMiddleware = routeConfig.middleware ?? [];
			const middleware = [...fileMiddleware, ...routeMiddleware, ...(contract.middleware ?? [])];
			const methodServices = pairServices(
				contract.services,
				route.services?.methods?.[key]?.names,
				{
					file: route.file,
					scope: `${method} services`,
					declare: `Declare them on the inline createRoute for ${method} with defineServices<Contract>()`,
				},
			);

			routes.push({
				method: key as HonoRoute["method"],
				path: route.path,
				contract: { ...contract, middleware },
				// The metadata lists the same chain in the same order unless it is stale, when
				// messages fall back to positions instead of naming the wrong middleware.
				...(chainMetadata.length === middleware.length && {
					middlewareNames: chainMetadata.map((item) => item.name),
				}),
				...((routeFileServices || methodServices) && {
					services: <NonNullable<HonoRoute["services"]>>{
						// The route file's factory follows the filesystem middleware; the method's also
						// follows the route file's own.
						routeFile: routeFileServices && { ...routeFileServices, after: fileMiddleware.length },
						method: methodServices && {
							...methodServices,
							after: fileMiddleware.length + routeMiddleware.length,
						},
					},
				}),
			});
		}
	}

	return routes;
}

async function loadMetadata(cwd: string, runtimeRoot: string): Promise<MetadataModule> {
	return (await import(
		pathToFileURL(runtimePath(cwd, runtimeRoot, ".routa/routes.gen.ts")).href
	)) as MetadataModule;
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
	const runtimeMode = process.argv[4];

	if (runtimeMode !== "dev" && runtimeMode !== "start") {
		throw new Error('Routa runtime mode must be explicitly set to "dev" or "start".');
	}

	await startRuntime(cwd, runtimeRoot, runtimeMode);
}
