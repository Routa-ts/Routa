import type { Diagnostic, ProjectModel } from "../project.js";

export function middlewareRejectStatusDiagnostics({ routes }: ProjectModel): Diagnostic[] {
	const diagnostics: Diagnostic[] = [];

	for (const route of routes) {
		for (const middleware of [
			...route.middleware,
			...Object.values(route.methodMiddleware).flat(),
		]) {
			for (const reject of middleware.rejects) {
				if (reject.status >= 400 && reject.status <= 599) {
					continue;
				}

				diagnostics.push({
					code: "ROUTA_MIDDLEWARE_REJECT_STATUS",
					severity: "error",
					message: `${middleware.name} reject "${reject.type}" uses non-error status ${reject.status}.`,
					file: middleware.file,
					routePath: route.path,
					suggestion: "Middleware rejects must use a 4xx or 5xx HTTP status.",
				});
			}
		}
	}

	return diagnostics;
}
