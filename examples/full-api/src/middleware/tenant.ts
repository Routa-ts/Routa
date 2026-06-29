import { createMiddleware } from "@routa/core";
import { z } from "zod";

export const withTenant = createMiddleware({
	requires: ["session"],
	input: {
		params: z.object({
			tenantId: z.string(),
		}),
	},
	provides: {
		tenant: z.object({
			id: z.string(),
			name: z.string(),
		}),
	},
	run: async ({ ctx, input, next }) => {
		return next({
			tenant: {
				id: input.params.tenantId,
				name: ctx.session.authenticated ? `Tenant ${input.params.tenantId}` : "Anonymous tenant",
			},
		});
	},
});
