import { createMiddleware } from "@routa-ts/core";
import { z } from "zod";

/**
 * App-owned auth guard for the full-api example.
 *
 * Kept local on purpose: core does not ship a built-in `requireAuth` until
 * create-routa-ts can offer a real auth template (e.g. Better Auth) with a
 * clear extension story. Missing/unauthenticated session → typed 401.
 */
export const requireAuth = createMiddleware({
	openapi: {
		security: [{ sessionCookie: [] }],
	},
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
		const session = ctx.session as { authenticated?: boolean; userId?: string } | null | undefined;

		if (!session?.authenticated || !session.userId) {
			return { type: "unauthorized", data: { message: "Authentication required" } };
		}

		return next({ auth: { userId: session.userId } });
	},
});
