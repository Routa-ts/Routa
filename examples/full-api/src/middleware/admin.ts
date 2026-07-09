import { createMiddleware } from "@routa-ts/core";
import { z } from "zod";

export const withAdmin = createMiddleware({
	requires: ["session"],
	provides: {
		admin: z.object({
			role: z.enum(["owner"]),
		}),
	},
	rejects: {
		unauthorized: {
			status: 401,
			schema: z.object({ message: z.string() }),
		},
		forbidden: {
			status: 403,
			schema: z.object({ message: z.string() }),
		},
	},
	run: async ({ ctx, next }) => {
		if (!ctx.session.authenticated) {
			return {
				type: "unauthorized",
				data: {
					message: "Authentication required",
				},
			};
		}

		if (ctx.session.userId !== "admin") {
			return {
				type: "forbidden",
				data: {
					message: "Admin access required",
				},
			};
		}

		return next({
			admin: {
				role: "owner",
			},
		});
	},
});
