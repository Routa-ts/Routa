import { createRoute, defineRoute } from "@routa-ts/core";
import { z } from "zod";

/**
 * Hand-written route (not OpenAPI-scaffolded).
 *
 * Shows `defineRoute` + Accept negotiation: clients may send
 * `Accept: application/problem+json` or other `application/*+json` types
 * and still receive JSON responses.
 */
export default defineRoute({
	get: createRoute({
		responses: {
			success: {
				status: 200,
				schema: z.object({
					message: z.string(),
					acceptsJsonSuffix: z.literal(true),
				}),
			},
		},
		run: () => {
			return {
				type: "success" as const,
				data: {
					message: "Hello, world!",
					acceptsJsonSuffix: true as const,
				},
			};
		},
	}),
});
