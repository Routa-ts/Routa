import type { Diagnostic, ProjectModel } from "../project.js";
import { requirementPlacements } from "../services.js";

/**
 * Reports middleware that requires a service its placement does not provide. Filesystem
 * middleware sees application services, route-file middleware also its route file's, and method
 * middleware also its method's. A name only a later factory builds is still unavailable.
 */
export function serviceRequirementDiagnostics({
	routes,
	services: application,
}: ProjectModel): Diagnostic[] {
	const fixes = {
		filesystem: (name: string) =>
			`Filesystem middleware sees only application services. Declare ${name} in the application services, or move the middleware into a route file or method that declares it.`,
		"route-file": (name: string) =>
			`Route-file middleware sees application and route-file services. Declare ${name} in one of them, or move the middleware into a method that declares it.`,
		method: (name: string) =>
			`Method middleware sees application, route-file, and method services. Declare ${name} in one of them.`,
	};
	const diagnostics: Diagnostic[] = [];

	for (const route of routes) {
		for (const placement of requirementPlacements(route)) {
			const { middleware } = placement;
			const available = new Set(
				[application, ...placement.scopes].flatMap((scope) => scope?.names ?? []),
			);

			for (const name of middleware.requiresServices.names) {
				if (available.has(name)) {
					continue;
				}

				const later = placement.later.find((scope) => scope.contract.names.includes(name));
				diagnostics.push({
					code: "ROUTA_SERVICES_UNAVAILABLE",
					severity: "error",
					message: `${placement.kind} middleware ${middleware.name} requires service ${JSON.stringify(name)}, which ${placement.where} does not provide before it runs.${
						later ? ` ${later.owner} declare it, but their factory runs after this middleware.` : ""
					}`,
					file: middleware.file,
					routePath: route.path,
					suggestion: fixes[placement.position](JSON.stringify(name)),
				});
			}
		}
	}

	return diagnostics;
}
