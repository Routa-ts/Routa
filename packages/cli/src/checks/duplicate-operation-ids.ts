import { operationId, toOpenApiPath } from "../operation-id.js";
import type { Diagnostic, ProjectModel } from "../project.js";

/**
 * Reports routes whose generated OpenAPI operationIds collide.
 *
 * The id comes from the method and path, and paths such as `/users/:id` and
 * `/users/id` spell the same words, so they can still produce one id.
 */
export function duplicateOperationIdDiagnostics({ routes }: ProjectModel): Diagnostic[] {
	const seen = new Map<string, string>();
	const diagnostics: Diagnostic[] = [];

	for (const route of routes) {
		for (const method of Object.keys(route.responses)) {
			const id = operationId(method, toOpenApiPath(route.path));
			const previous = seen.get(id);

			if (!previous) {
				seen.set(id, `${method.toUpperCase()} ${route.path}`);
				continue;
			}

			diagnostics.push({
				code: "ROUTA_DUPLICATE_OPERATION_ID",
				severity: "error",
				message: `${method.toUpperCase()} ${route.path} and ${previous} would both generate the OpenAPI operationId ${id}.`,
				file: route.file,
				routePath: route.path,
				suggestion:
					"Rename a path segment so the two routes differ by more than punctuation or parameter syntax. Routa generates operationIds from the method and path.",
			});
		}
	}

	return diagnostics;
}
