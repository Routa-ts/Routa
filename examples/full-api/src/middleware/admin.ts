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
		// Routa authenticated the request; deciding who administers is application authorization.
		const isAdmin =
			ctx.auth.status === "authenticated"
			&& ctx.auth.principal.type === "account"
			&& ctx.auth.principal.id === "admin";

		if (!isAdmin) {
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
