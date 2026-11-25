import type { Diagnostic, ProjectModel, RouteMetadata } from "../project.js";

/**
 * Reports routes that share the same path.
 *
 * @param routes - The discovered route metadata to inspect.
 * @returns Diagnostics for each duplicate route path.
 */
export function duplicateRouteDiagnostics({ routes }: ProjectModel): Diagnostic[] {
	const seen = new Map<string, RouteMetadata>();
	const diagnostics: Diagnostic[] = [];

	for (const route of routes) {
		const previous = seen.get(route.path);

		if (previous) {
			diagnostics.push({
				code: "ROUTA_DUPLICATE_ROUTE",
				severity: "error",
				message: `Duplicate route path ${route.path}.`,
				file: route.file,
				routePath: route.path,
				suggestion: `Rename or move ${route.file}; it conflicts with ${previous.file}.`,
			});
			continue;
		}

		seen.set(route.path, route);
	}

	return diagnostics;
}
