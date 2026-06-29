import { createMiddleware } from "@routa/core";
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

export const withSession = createMiddleware({
	requires: ["requestId"],
	input: {
		cookies: z.object({
			session: z.string().optional(),
		}),
	},
	provides: {
		session: z.object({
			authenticated: z.boolean(),
			userId: z.string().optional(),
		}),
	},
	run: async ({ input, next }) => {
		const session = verifySession(input.cookies.session);

		return next({
			session,
		});
	},
});

function verifySession(token: string | undefined): { authenticated: boolean; userId?: string } {
	if (!token?.startsWith("demo-user:")) {
		return { authenticated: false };
	}

	const userId = token.slice("demo-user:".length).trim();

	return userId ? { authenticated: true, userId } : { authenticated: false };
}
