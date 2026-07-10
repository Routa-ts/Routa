import { createRoute, defineRoute } from "@routa-ts/core";
import { z } from "zod";

/**
 * Flat route file: `legacy.ts` maps directly to `/legacy`.
 *
 * This endpoint is deliberately deprecated so the example exercises generated
 * OpenAPI deprecation metadata and lifecycle response headers.
 */
export default defineRoute({
	get: createRoute({
		deprecation: {
			sunset: "2027-01-01",
			replacement: "/status",
		},
		responses: {
			success: {
				status: 200,
				schema: z.object({ message: z.string() }),
			},
		},
		run: () => ({ type: "success", data: { message: "Use /status instead." } }),
	}),
});
