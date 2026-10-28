import { createMiddleware } from "@routa-ts/core";
import { z } from "zod";
import { sessionCookie, signedInCookie } from "../cookies.js";

/**
 * App-owned auth guard for the full-api example.
 *
 * Kept local on purpose: core does not ship a built-in `requireAuth` until
 * create-routa-ts can offer a real auth template (e.g. Better Auth) with a
 * clear extension story. Missing/unauthenticated session → typed 401, which
 * also clears a session cookie the request sent, because it no longer works,
 * and the `signed_in` hint, because browser code must not report a session.
 */
export const requireAuth = createMiddleware({
	openapi: {
		security: [{ sessionCookie: [] }],
	},
	requires: ["session"],
	input: {
		cookies: z.object({ session: z.string().optional() }),
	},
	provides: {
		auth: z.object({
			userId: z.string(),
		}),
	},
	rejects: {
		unauthorized: {
			status: 401,
			schema: z.object({ message: z.string() }),
			cookies: [sessionCookie, signedInCookie],
		},
	},
	run: ({ ctx, input, next }) => {
		const session = ctx.session as { authenticated?: boolean; userId?: string } | null | undefined;

		if (!session?.authenticated || !session.userId) {
			return {
				type: "unauthorized",
				data: { message: "Authentication required" },
				cookies: input.cookies.session
					? [sessionCookie.clear(), signedInCookie.clear()]
					: [signedInCookie.clear()],
			};
		}

		return next({ auth: { userId: session.userId } });
	},
});
