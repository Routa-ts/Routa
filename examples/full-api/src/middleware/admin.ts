import { createMiddleware } from "@routa-ts/core";
import { z } from "zod";

export const withAdmin = createMiddleware({
	openapi: {
		permissions: ["audit.read"],
	},
	requires: ["auth"],
	provides: {
		admin: z.object({
			role: z.enum(["owner"]),
		}),
	},
	rejects: {
		forbidden: {
			status: 403,
			schema: z.object({ message: z.string() }),
		},
	},
	run: async ({ ctx, next }) => {
		if (ctx.auth.userId !== "admin") {
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
