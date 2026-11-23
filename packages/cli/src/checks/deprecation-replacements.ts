import type { Diagnostic, ProjectModel } from "../project.js";

export function deprecationReplacementDiagnostics({ routes }: ProjectModel): Diagnostic[] {
	const paths = new Set(routes.map((route) => route.path));
	const diagnostics: Diagnostic[] = [];

	for (const route of routes) {
		for (const [method, deprecation] of Object.entries(route.deprecations ?? {})) {
			if (!deprecation) continue;
			const replacement = deprecation.replacement;
			if (!replacement) continue;

			if (replacement.startsWith("/")) {
				if (!paths.has(replacement)) {
					diagnostics.push({
						code: "ROUTA_DEPRECATION_REPLACEMENT_ROUTE_NOT_FOUND",
						severity: "error",
						message: `${method.toUpperCase()} ${route.path} deprecation replacement ${replacement} is not a Routa route.`,
						file: route.file,
						routePath: route.path,
						suggestion:
							"Use an existing local path beginning with /, or an absolute http(s) URL for another API.",
					});
				}
				continue;
			}

			if (!isExternalApiUrl(replacement)) {
				diagnostics.push({
					code: "ROUTA_DEPRECATION_REPLACEMENT_URL_INVALID",
					severity: "error",
					message: `${method.toUpperCase()} ${route.path} deprecation replacement must be an existing local path or absolute http(s) URL.`,
					file: route.file,
					routePath: route.path,
					suggestion:
						"Use /new-route for this API, or https://api.example.com/new-route for another API.",
				});
			}
		}
	}

	return diagnostics;
}

function isExternalApiUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}
