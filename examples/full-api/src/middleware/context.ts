import { createMiddleware } from "@routa-ts/core";
import { z } from "zod";

export const withRequest = createMiddleware({
	input: {
		headers: z.object({
			"x-request-id": z.string().optional(),
		}),
	},
	provides: {
		requestId: z.string(),
	},
	run: async ({ input, next }) => {
		return next({
			requestId: input.headers["x-request-id"] ?? "local-request",
		});
	},
});
