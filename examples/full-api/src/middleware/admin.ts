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
		if (!ctx.session.authenticated) {
			throw new Response("Authentication required", { status: 401 });
		}

		return next({
			admin: {
				role: "owner",
			},
		});
	},
});
