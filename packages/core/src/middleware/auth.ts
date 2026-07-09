import { z } from "zod";
import { createMiddleware } from "../index.js";

/**
 * Creates middleware that provides an `auth` value.
 *
 * @returns Middleware that declares `auth` as a validated object.
 */
export function requireAuth() {
	return createMiddleware({
		requires: ["session"],
		provides: {
			auth: z.object({
				userId: z.string(),
			}),
		},
		rejects: {
			unauthorized: {
				status: 401,
				schema: z.object({ message: z.string() }),
			},
		},
		run: ({ ctx, next }) => {
			const session = ctx.session as { authenticated?: boolean; userId?: string };

			if (!session.authenticated || !session.userId) {
				return { type: "unauthorized", data: { message: "Authentication required" } };
			}

			return next({ auth: { userId: session.userId } });
		},
	});
}
