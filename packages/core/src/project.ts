import { createApplication, type HonoRoute, type RoutaApplication } from "./hono.js";
import type { RoutaConfig } from "./index.js";
import { createLogger, type RoutaLogger } from "./logger.js";
import type { ApplicationServicesDeclaration } from "./services.js";

/**
 * Imports one of a project's modules by its path from the project root, such as `src/routa.ts`
 * or `.routa/routes.gen.ts`. `routa start` imports the files; a test application imports them
 * through the generated `.routa/testing.gen.ts`.
 */
export type ProjectModuleLoader = (file: string) => Promise<unknown>;

/**
 * Factories that replace the declared ones before construction, as `createTestApp` accepts them:
 * the application's in `services`, a route file's in `routes[path].services`, and a method's in
 * `routes[path].methods[method].services`. A replaced scope's original factory never runs.
 */
export type ServiceReplacements = {
	readonly services?: unknown;
	readonly routes?: Readonly<
		Record<
			string,
			{
				readonly services?: unknown;
				readonly methods?: Readonly<Record<string, { readonly services?: unknown }>>;
			}
		>
	>;
};

export type CreateProjectApplicationOptions = {
	/** The explicit runtime command mode. */
	runtimeMode: "dev" | "start";
	replacements?: ServiceReplacements;
};

/** A project's application instance, with the configuration and logger it was built from. */
export type ProjectApplication = {
	application: RoutaApplication;
	config: RoutaConfig;
	logger: RoutaLogger | undefined;
	routes: readonly HonoRoute[];
};

type ServiceNamesMetadata = { readonly names: readonly string[] };

type MiddlewareReference = { readonly file: string; readonly name: string };

/** The parts of a `routaRoutes` entry that building the application reads. */
type RouteMetadata = {
	readonly file: string;
	readonly path: string;
	readonly methods: readonly string[];
	readonly middleware?: readonly MiddlewareReference[];
	readonly methodMiddleware?: Readonly<Record<string, readonly MiddlewareReference[]>>;
	readonly services?: {
		readonly routeFile?: ServiceNamesMetadata;
		readonly methods?: Readonly<Record<string, ServiceNamesMetadata>>;
	};
};

type MetadataModule = {
	routaRoutes: readonly RouteMetadata[];
	routaApplicationServices?: readonly string[];
};

type Middleware = NonNullable<HonoRoute["contract"]["middleware"]>[number];

type RouteModule = {
	default?: Record<string, HonoRoute["contract"]> & {
		middleware?: readonly Middleware[];
		services?: unknown;
	};
};

/**
 * Builds a project's application instance without listening: it loads the generated route
 * metadata, `src/routa.ts`, the route modules, and their middleware, then constructs the
 * application services. `routa start` and generated test applications both build through it.
 *
 * @param load - Imports a project module by its path from the project root
 * @throws When a replacement names a route, method, or scope that declares no services, when
 *   `src/routa.ts` or a route file and the generated metadata disagree about services, or when
 *   the application services factory fails
 */
export async function createProjectApplication(
	load: ProjectModuleLoader,
	options: CreateProjectApplicationOptions,
): Promise<ProjectApplication> {
	const metadata = (await load(".routa/routes.gen.ts")) as MetadataModule;
	const replacements = options.replacements ?? {};
	assertReplacements(replacements, metadata);
	const routes = await loadRoutes(load, metadata.routaRoutes, replacements);
	const config = ((await load("src/routa.ts")) as { default?: RoutaConfig }).default ?? {};
	const logger = config.logger === false ? undefined : (config.logger ?? createLogger());
	const services = pairServices(config.services, metadata.routaApplicationServices, {
		file: "src/routa.ts",
		scope: "application services",
		declare: "Declare services in the createRouta object with defineServices<Contract>()",
		replacement: replacements.services,
	});
	const application = await createApplication(routes, {
		runtimeMode: options.runtimeMode,
		...(logger && { logger }),
		...(config.lifecycleHeaders !== undefined && { lifecycleHeaders: config.lifecycleHeaders }),
		...(config.responseValidation && { responseValidation: config.responseValidation }),
		...(services && { services: services as ApplicationServicesDeclaration }),
	});

	return { application, config, logger, routes };
}

/**
 * Rejects replacements for scopes the generated metadata does not declare, before any module
 * loads or factory runs. TypeScript reports the same mistakes in a generated test application.
 */
function assertReplacements(replacements: ServiceReplacements, metadata: MetadataModule): void {
	const replace = (label: string, factory: unknown, names: readonly string[] | undefined) => {
		if (factory === undefined) {
			return;
		}

		if (!names) {
			throw new TypeError(`Cannot replace services for ${label}: it declares none.`);
		}

		if (typeof factory !== "function") {
			throw new TypeError(`The replacement services for ${label} must be a factory.`);
		}
	};

	replace("the application", replacements.services, metadata.routaApplicationServices);

	for (const [path, route] of Object.entries(replacements.routes ?? {})) {
		const declared = metadata.routaRoutes.find((item) => item.path === path);

		if (!declared) {
			throw new TypeError(`Cannot replace services for ${path}: no route file declares it.`);
		}

		replace(`route file ${path}`, route.services, declared.services?.routeFile?.names);

		for (const [method, scope] of Object.entries(route.methods ?? {})) {
			const label = `${method.toUpperCase()} ${path}`;

			if (method !== method.toLowerCase() || !declared.methods.includes(method.toUpperCase())) {
				throw new TypeError(
					`Cannot replace services for ${label}: the route file declares no such method.`,
				);
			}

			replace(label, scope.services, declared.services?.methods?.[method]?.names);
		}
	}
}

/**
 * Pairs a configured services factory with the names `routa generate` read for its contract. A
 * replacement takes the factory's place, so the configured factory is checked but never called.
 *
 * @param where - The module that configures the factory, the scope's name in messages, how to
 *   declare it, and the factory that replaces it
 * @throws When only one side declares the services, or `services` is not a function
 */
function pairServices(
	factory: unknown,
	names: readonly string[] | undefined,
	where: { file: string; scope: string; declare: string; replacement?: unknown },
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

	return {
		factory: (where.replacement ?? factory) as (context: never) => unknown,
		names,
	};
}

/**
 * Assembles the Hono route list: each route module's method contracts, with the filesystem,
 * route-file, and method middleware chained in order and each scope's services paired.
 *
 * @throws If a route file does not export a default route config or is missing a method contract
 */
async function loadRoutes(
	load: ProjectModuleLoader,
	metadata: readonly RouteMetadata[],
	replacements: ServiceReplacements,
): Promise<HonoRoute[]> {
	const routes: HonoRoute[] = [];

	for (const route of metadata) {
		const routeConfig = ((await load(route.file)) as RouteModule).default;

		if (!routeConfig) {
			throw new Error(`Route file ${route.file} does not export a default route config.`);
		}

		const replaced = replacements.routes?.[route.path];
		const routeFileServices = pairServices(routeConfig.services, route.services?.routeFile?.names, {
			file: route.file,
			scope: "route-file services",
			declare: "Declare them on the route root with defineServices<Contract>()",
			replacement: replaced?.services,
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
			const fileMiddleware = await loadFileMiddleware(load, route.file, chainMetadata);
			const routeMiddleware = routeConfig.middleware ?? [];
			const middleware = [...fileMiddleware, ...routeMiddleware, ...(contract.middleware ?? [])];
			const methodServices = pairServices(
				contract.services,
				route.services?.methods?.[key]?.names,
				{
					file: route.file,
					scope: `${method} services`,
					declare: `Declare them on the inline createRoute for ${method} with defineServices<Contract>()`,
					replacement: replaced?.methods?.[key]?.services,
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

/**
 * Loads the filesystem middleware a route's metadata lists.
 *
 * @param routeFile - The current route file, whose own middleware the route config already holds
 */
async function loadFileMiddleware(
	load: ProjectModuleLoader,
	routeFile: string,
	metadata: readonly MiddlewareReference[],
): Promise<Middleware[]> {
	const middleware: Middleware[] = [];

	for (const item of metadata) {
		// Invariant: route-local middleware is already applied via
		// `routeConfig.middleware` / `contract.middleware` in `loadRoutes`.
		// Skip `item.file === routeFile` so those contracts are not imported
		// and stacked a second time.
		if (item.file === routeFile) {
			continue;
		}

		const module = (await load(item.file)) as Record<string, unknown>;
		const contract = module[item.name];

		if (
			!contract
			|| typeof contract !== "object"
			|| Array.isArray(contract)
			|| typeof (contract as { run?: unknown }).run !== "function"
		) {
			throw new Error(`Middleware ${item.name} was not exported by ${item.file}.`);
		}

		middleware.push(contract as Middleware);
	}

	return middleware;
}
