import type { Diagnostic, ProjectModel } from "../project.js";
import type { ServiceContractMetadata } from "../services.js";

/**
 * Reports a service name that more than one scope combined for a request declares: the
 * application, the route file, and one method. Unrelated route files and methods may reuse names.
 */
export function serviceCollisionDiagnostics({
	routes,
	services: application,
}: ProjectModel): Diagnostic[] {
	type Scope = { owner: string; contract: ServiceContractMetadata };
	const diagnostics: Diagnostic[] = [];

	for (const route of routes) {
		const { routeFile, methods = {} } = route.services ?? {};
		const applicationScope: Scope[] = application
			? [{ owner: "the application services in src/routa.ts", contract: application }]
			: [];
		const routeFileScope: Scope[] = routeFile
			? [{ owner: "the route file's services", contract: routeFile }]
			: [];
		const scopes = [
			...routeFileScope.map((scope) => ({ ...scope, earlier: applicationScope })),
			...Object.entries(methods).map(([method, contract]) => ({
				owner: `the ${method.toUpperCase()} services`,
				contract,
				earlier: [...applicationScope, ...routeFileScope],
			})),
		];

		for (const { owner, contract, earlier } of scopes) {
			for (const name of contract.names) {
				const first = earlier.find((scope) => scope.contract.names.includes(name));

				if (first) {
					diagnostics.push({
						code: "ROUTA_SERVICES_DUPLICATE",
						severity: "error",
						message: `Service "${name}" is declared by ${first.owner} and by ${owner}, which run in one request.`,
						file: route.file,
						routePath: route.path,
						suggestion:
							"Rename one of the services. Services combined for one request need distinct names; unrelated route files and methods may reuse a name.",
					});
				}
			}
		}
	}

	return diagnostics;
}
