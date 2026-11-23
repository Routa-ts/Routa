import type { Diagnostic, ProjectModel } from "../project.js";

/**
 * Reports route methods that do not declare a 2xx success response.
 *
 * DELETE methods are included and may satisfy the check with a 204 response.
 *
 * @param routes - Route metadata to inspect
 * @returns Diagnostics for route methods missing a declared 2xx response
 */
export function missingSuccessResponseDiagnostics({ routes }: ProjectModel): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];

	for (const route of routes) {
		for (const [method, statuses] of Object.entries(route.responses)) {
			if (!statuses.some((status) => status >= 200 && status < 300)) {
				diagnostics.push({
					code: "ROUTA_MISSING_SUCCESS_RESPONSE",
					severity: "error",
					message: `${method.toUpperCase()} ${route.path} is missing a 2xx success response.`,
					file: route.file,
					routePath: route.path,
					suggestion:
						method === "delete"
							? "Add a declared success response with a 2xx HTTP status (204 is allowed)."
							: "Add a declared success response with a 2xx HTTP status.",
				});
			}
		}
	}

	return diagnostics;
}
