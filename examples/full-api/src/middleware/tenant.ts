import { createMiddleware } from "@routa-ts/core";
import { z } from "zod";

export const withTenant = createMiddleware({
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
	run: async ({ input, next }) => {
		return next({
			tenant: {
				id: input.params.tenantId,
				name: `Tenant ${input.params.tenantId}`,
			},
		});
	},
});
