/**
 * What kind of failure Routa reports to `onRequestError` and in `http.error`. Descriptions are
 * Markdown text with inline code spans.
 */
export const requestErrorCodes = [
	{
		name: "unexpected_failure",
		description:
			"Application code threw, or Routa failed for a reason it did not expect. The callback receives what was thrown: for an authenticator, extractor, principal schema, services factory, response data `JSON.stringify` throws for, such as a bigint, a circular reference, or a throwing `toJSON()` or getter, or a refinement in a response, header, cookie, or `provides` schema, its own error",
	},
	{
		name: "contract_violation",
		description:
			"Application code produced a value its declared contract forbids, such as response data, headers, or cookies that fail the outcome's schema, response data JSON writes no text for, such as `undefined`, a `next()` payload that fails `provides`, a services factory result that is not exactly its declared services, or an authenticator result or principal that fails its contract without throwing. The callback receives Routa's error, which describes the violation",
	},
	{
		name: "configuration_error",
		description:
			"The application is configured in a way Routa cannot serve safely: a Routa app mounted in another Routa app with `route()`, which Routa does not support. The callback receives Routa's error, which says so and what to do instead",
	},
] as const;

/**
 * Where in the request a reported failure happened, in the order a request reaches each stage.
 * Descriptions are Markdown text with inline code spans.
 */
export const requestErrorStages = [
	{
		name: "identity",
		description: "Identifying the request: a Routa app mounted in another Routa app received it",
	},
	{
		name: "authentication",
		description:
			"Resolving credentials: an authenticator or extractor threw or returned an invalid result",
	},
	{
		name: "context",
		description:
			"Building a low-level `createContext` value, including reading the object it returns",
	},
	{
		name: "input",
		description:
			"Reading input, such as a schema refinement that throws instead of reporting an issue",
	},
	{ name: "services", description: "A route-file or method services factory" },
	{
		name: "middleware",
		description: "A middleware callback, including what it passes to `next()` and what it returns",
	},
	{
		name: "handler",
		description: "The route handler, including a return value that is not an outcome result at all",
	},
	{
		name: "response",
		description:
			"Preparing the response: reading the route's `deprecation` for lifecycle headers, and checking and serializing the selected outcome, including an outcome type the route does not declare, and its body, headers, and cookies",
	},
] as const;
