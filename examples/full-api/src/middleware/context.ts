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
		return next({
			session: input.cookies.session
				? { authenticated: true, userId: input.cookies.session }
				: { authenticated: false },
		});
	},
});
