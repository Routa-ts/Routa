/**
 * Converts a value to PascalCase, treating every run of non-alphanumeric
 * characters as a word break.
 *
 * @returns The PascalCase text, or `Operation` when nothing remains.
 */
export function pascalCase(value: string): string {
	const text = value.replaceAll(/[^a-zA-Z0-9]+/g, " ").trim();

	if (!text) {
		return "Operation";
	}

	return text
		.split(/\s+/)
		.map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
		.join("");
}

/**
 * Converts a route path with `:param` segments to an OpenAPI path template.
 */
export function toOpenApiPath(routePath: string): string {
	return routePath.replaceAll(/:([^/]+)/g, "{$1}");
}

/**
 * Names an OpenAPI operation from its method and path: `get` and
 * `/users/{id}` become `getUsersId`. Source generation and scaffolding share
 * this rule, so a scaffolded project regenerates the identifier it suggested.
 *
 * @param method - The lowercase HTTP method
 * @param openApiPath - The OpenAPI path template
 */
export function operationId(method: string, openApiPath: string): string {
	return `${method}${pascalCase(openApiPath)}`;
}
