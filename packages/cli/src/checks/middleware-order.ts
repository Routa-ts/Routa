import type { Diagnostic, ProjectModel } from "../project.js";

/**
 * Validates middleware ordering for each route.
 *
 * @returns Diagnostics for middleware that requires context before it has been provided.
 */
export function middlewareOrderDiagnostics({ routes, authentication }: ProjectModel): Diagnostic[] {
	const authenticated = authentication !== undefined;
	const diagnostics: Diagnostic[] = [];

	for (const route of routes) {
		const chains =
			route.methods.length > 0
				? route.methods.map(
						(item) => route.methodMiddleware[item.toLowerCase()] ?? route.middleware,
					)
				: [route.middleware];

		for (const chain of chains) {
			// Credential orchestration resolves ctx.auth before the first middleware runs, and Routa
			// gives every middleware the request identity and logger.
			const provided = new Set<string>([
				...(authenticated ? ["auth"] : []),
				"requestId",
				"correlationId",
				"logger",
			]);

			for (const middleware of chain) {
				for (const required of middleware.requires) {
					if (!provided.has(required)) {
						diagnostics.push({
							code: "ROUTA_MIDDLEWARE_ORDER",
							severity: "error",
							message: `${middleware.name} requires ctx.${required} before it is provided.`,
							file: middleware.file,
							routePath: route.path,
							suggestion: `Move middleware that provides ${required} before ${middleware.name}.`,
						});
					}
				}

				for (const providedField of middleware.provides) {
					provided.add(providedField);
				}
			}
		}
	}

	return diagnostics;
}
