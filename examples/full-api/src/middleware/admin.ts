import { createMiddleware } from "@routa-ts/core";
import { z } from "zod";

export const withAdmin = createMiddleware({
	requires: ["session"],
	provides: {
		admin: z.object({
			role: z.enum(["owner"]),
		}),
	},
	run: async ({ ctx, next }) => {
		if (!ctx.session.authenticated) {
			throw new Response("Authentication required", { status: 401 });
		}

		if (ctx.session.userId !== "admin") {
			throw new Response("Admin access required", { status: 403 });
		}

		return next({
			admin: {
				role: "owner",
			},
		});
	},
});
