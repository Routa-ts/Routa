import { existsSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { type AuthenticationMetadata, rejectsAmbiguousCredentials } from "./authentication.js";
import {
	type FolderMiddleware,
	parseMiddlewareFile,
	parseRouteFileMiddleware,
} from "./middleware-contracts.js";
import type { Diagnostic, MiddlewareMetadata, RouteMetadata } from "./project.js";
import { parseRouteContract, type ResponseOutcomeDeclaration } from "./route-contracts.js";
import { routeServices } from "./services.js";
import type * as ts from "./typescript.js";

export const routesRoot = join("src", "routes");

type RouteDiscovery = {
	routes: RouteMetadata[];
	diagnostics: Diagnostic[];
};

/**
 * Discovers route metadata from a Routa project's route files.
 *
 * @param cwd - Project root directory
 * @returns The discovered route metadata for each `route.ts` file under `src/routes`, plus discovery diagnostics
 */
export function discoverRoutes(
	cwd: string,
	parser: ts.SourceFileParser,
	authentication: AuthenticationMetadata | undefined,
): RouteDiscovery {
	const routesDir = join(cwd, routesRoot);

	if (!existsSync(routesDir)) {
		return { routes: [], diagnostics: [] };
	}

	const sources = walk(routesDir);
	const files = sources.filter(isRouteFile);
	const folders = new Map<string, FolderMiddleware>();
	const folderMiddleware = (file: string) => {
		const parsed = folders.get(file) ?? parseMiddlewareFile(cwd, file, parser, authentication);
		folders.set(file, parsed);
		return parsed.middleware;
	};
	const diagnostics: Diagnostic[] = [];

	for (const file of sources.filter((item) => basename(item) === "middleware.ts")) {
		folderMiddleware(relative(cwd, file));
	}

	const routes = files.flatMap((file) => {
		const relativeFile = relative(cwd, file);
		const rawSegments = rawRouteSegments(routesDir, file);
		const groups = rawSegments.filter(
			(segment) => segment.startsWith("(") && segment.endsWith(")"),
		);
		const segments = rawSegments.filter(
			(segment) => !(segment.startsWith("(") && segment.endsWith(")")),
		);
		const middlewareFiles = folderMiddlewareFiles(cwd, rawSegments);
		const inheritedMiddleware = middlewareFiles.flatMap(folderMiddleware);
		const routeFileMiddleware = parseRouteFileMiddleware(cwd, relativeFile, parser, authentication);
		const middleware = [...inheritedMiddleware, ...routeFileMiddleware.route];
		const methodMiddleware = Object.fromEntries(
			Object.entries(routeFileMiddleware.methods).map(([method, items]) => [
				method,
				[...middleware, ...items],
			]),
		);
		const path = routePathForFile(routesDir, file);
		const parsed = parseRouteContract(file, parser);

		if (!parsed.configFound) {
			diagnostics.push({
				code: "ROUTA_ROUTE_CONFIG_UNRESOLVED",
				severity: "error",
				message: `Route config in ${relativeFile} could not be resolved.`,
				file: relativeFile,
				routePath: path,
				suggestion: `Export a route config created by createRouteRoot(${JSON.stringify(path)}).`,
			});
			return [];
		}

		if (parsed.explicitOptions) {
			diagnostics.push({
				code: "ROUTA_OPTIONS_AUTOMATIC",
				severity: "error",
				message: `OPTIONS ${path} must not be declared explicitly.`,
				file: relativeFile,
				routePath: path,
				suggestion:
					"Remove the options contract. Routa generates OPTIONS and its Allow header from the path's declared methods.",
			});
		}

		const contract = parsed.contract;
		const services = routeServices(cwd, relativeFile, parser);
		diagnostics.push(...services.diagnostics.map((item) => ({ ...item, routePath: path })));
		const ctx = Array.from(
			new Set([
				...middleware.flatMap((item) => item.provides),
				...Object.values(methodMiddleware).flatMap((items) =>
					items.flatMap((item) => item.provides),
				),
			]),
		).sort();

		diagnostics.push(
			...routeFileMiddleware.diagnostics.map((item) => ({ ...item, routePath: path })),
		);

		for (const unresolved of routeFileMiddleware.unresolved) {
			diagnostics.push({
				code: "ROUTA_MIDDLEWARE_UNRESOLVED",
				severity: "error",
				message: `Middleware ${unresolved} cannot be statically resolved, so it would run without contract checks.`,
				file: relativeFile,
				routePath: path,
				suggestion:
					"Reference middleware as a direct identifier of a createMiddleware export, and list entries explicitly instead of spreading arrays.",
			});
		}

		for (const [method, metadata] of Object.entries(contract)) {
			diagnostics.push(...outcomeRuleDiagnostics(method, metadata.outcomes, relativeFile, path));
		}

		return [
			{
				file: relativeFile,
				path,
				methods: Object.keys(contract).map((method) => method.toUpperCase()),
				responses: Object.fromEntries(
					Object.entries(contract).map(([method, metadata]) => [
						method,
						methodResponseStatuses(
							// Every operation can fail authentication once credentials are resolved.
							authentication
								? [
										...metadata.responses,
										401,
										...(rejectsAmbiguousCredentials(
											methodMiddleware[method] ?? middleware,
											authentication,
										)
											? [400]
											: []),
									]
								: metadata.responses,
							methodMiddleware[method] ?? middleware,
						),
					]),
				),
				inputs: Object.fromEntries(
					Object.entries(contract).map(([method, metadata]) => [method, metadata.inputs]),
				),
				...(Object.values(contract).some((metadata) => metadata.deprecation)
					? {
							deprecations: Object.fromEntries(
								Object.entries(contract).flatMap(([method, metadata]) =>
									metadata.deprecation ? [[method, metadata.deprecation]] : [],
								),
							),
						}
					: {}),
				middleware,
				methodMiddleware,
				...(authentication && { middlewareFiles }),
				...(services.services && { services: services.services }),
				ctx,
				groups,
				segments,
			},
		];
	});

	// A guard two folders re-export from one module is reported once, where its call is written.
	const folderDiagnostics = new Map(
		[...folders.values()]
			.flatMap((folder) => folder.diagnostics)
			.map((item) => [`${item.code}\0${item.file}\0${item.message}`, item]),
	);

	return { routes, diagnostics: [...folderDiagnostics.values(), ...diagnostics] };
}

export function isRouteFile(file: string): boolean {
	const name = basename(file);
	return (
		name === "route.ts"
		|| (name.endsWith(".ts")
			&& name !== "middleware.ts"
			&& name !== "schemas.ts"
			&& !name.endsWith(".test.ts"))
	);
}

function flatRouteSegments(file: string): string[] {
	return file.slice(0, -".ts".length).split(".");
}

function rawRouteSegments(routesDir: string, file: string): string[] {
	const relativeRouteDir = relative(routesDir, dirname(file));
	const directorySegments = relativeRouteDir === "" ? [] : relativeRouteDir.split(sep);

	return [
		...directorySegments,
		...(basename(file) === "route.ts" ? [] : flatRouteSegments(basename(file))),
	];
}

export function routePathForFile(routesDir: string, file: string): string {
	const segments = rawRouteSegments(routesDir, file)
		.filter((segment) => !(segment.startsWith("(") && segment.endsWith(")")))
		.map((segment) => (segment.startsWith("$") ? `:${segment.slice(1)}` : segment));

	return `/${segments.join("/")}`.replace(/\/$/, "") || "/";
}

function methodResponseStatuses(
	routeStatuses: readonly number[],
	middleware: readonly MiddlewareMetadata[],
): number[] {
	return Array.from(
		new Set([
			...routeStatuses,
			...middleware.flatMap((item) => item.rejects.map((reject) => reject.status)),
		]),
	).sort((left, right) => left - right);
}

/**
 * Reports outcome declarations that HTTP or the route method forbids: terminal 1xx
 * statuses, body schemas on 204, 205, 304 and every HEAD outcome, and 304 outside GET and HEAD.
 *
 * TypeScript rejects the same declarations first. This covers what it cannot see, such as
 * the method a contract is registered under or a contract built outside the route config.
 */
function outcomeRuleDiagnostics(
	method: string,
	outcomes: readonly ResponseOutcomeDeclaration[],
	file: string,
	routePath: string,
): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];
	const label = `${method.toUpperCase()} ${routePath}`;

	for (const { name, status, hasSchema } of outcomes) {
		if (status === undefined) {
			continue;
		}

		if (status >= 100 && status < 200) {
			diagnostics.push({
				code: "ROUTA_RESPONSE_INFORMATIONAL_STATUS",
				severity: "error",
				message: `Outcome "${name}" on ${label} uses informational status ${status}, which cannot be a terminal route outcome.`,
				file,
				routePath,
				suggestion: "Use a final status from 200 to 599.",
			});
		}

		if (hasSchema && (status === 204 || status === 205 || status === 304)) {
			diagnostics.push({
				code: "ROUTA_RESPONSE_BODYLESS_SCHEMA",
				severity: "error",
				message: `Outcome "${name}" on ${label} declares a schema, but status ${status} has no body.`,
				file,
				routePath,
				suggestion: "Remove the schema and return no data, or choose a status that carries a body.",
			});
		} else if (hasSchema && method === "head") {
			diagnostics.push({
				code: "ROUTA_RESPONSE_BODYLESS_SCHEMA",
				severity: "error",
				message: `Outcome "${name}" on ${label} declares a schema, but HEAD responses have no body.`,
				file,
				routePath,
				suggestion: "Remove the schema and return no data from HEAD outcomes.",
			});
		}

		if (status === 304 && method !== "get" && method !== "head") {
			diagnostics.push({
				code: "ROUTA_RESPONSE_NOT_MODIFIED_METHOD",
				severity: "error",
				message: `Outcome "${name}" on ${label} uses status 304, which is valid only for GET and HEAD.`,
				file,
				routePath,
				suggestion: "Use a different status, or move the outcome to a GET or HEAD route.",
			});
		}
	}

	return diagnostics;
}

/**
 * Lists the folder `middleware.ts` files a route inherits middleware from, root first.
 *
 * @param cwd - Project root directory
 * @param rawSegments - Route path segments used to locate nested `middleware.ts` files
 * @returns The root routes `middleware.ts` and each nested one that exists, relative to `cwd`
 */
function folderMiddlewareFiles(cwd: string, rawSegments: string[]): string[] {
	const candidates = [`${routesRoot}/middleware.ts`];
	let current = routesRoot;

	for (const segment of rawSegments) {
		current = join(current, segment);
		candidates.push(join(current, "middleware.ts"));
	}

	return candidates.filter((file) => existsSync(join(cwd, file)));
}

/**
 * Recursively lists all files under a directory.
 *
 * Symlink cycles are skipped by tracking visited real paths.
 *
 * @param dir - The directory to traverse
 * @param visited - Real paths already visited during this walk
 * @returns The full paths of all files found under `dir`
 */
export function walk(dir: string, visited = new Set<string>()): string[] {
	let realDir: string;

	try {
		realDir = realpathSync(dir);
	} catch {
		return [];
	}

	if (visited.has(realDir)) {
		return [];
	}

	visited.add(realDir);

	return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
		const file = join(dir, entry.name);

		if (entry.isSymbolicLink()) {
			let stats: ReturnType<typeof statSync>;

			try {
				stats = statSync(file);
			} catch {
				return [];
			}

			return stats.isDirectory() ? walk(file, visited) : [file];
		}

		return entry.isDirectory() ? walk(file, visited) : [file];
	});
}
