import { createMiddleware } from "@routa/core";
import { z } from "zod";

export const withAdmin = createMiddleware({
	requires: ["session"],
	provides: {
		admin: z.object({
			role: z.string(),
		}),
	},
	run: async ({ ctx, next }) => {
		return next({
			admin: {
				role: ctx.session.authenticated ? "owner" : "guest",
			},
		});
	},
});
