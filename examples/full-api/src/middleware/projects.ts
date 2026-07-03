import { createMiddleware } from "@routa-ts/core";
import { z } from "zod";

export const withProjectScope = createMiddleware({
	requires: ["tenant", "session"],
	provides: {
		projectScope: z.object({
			tenantId: z.string(),
			canWrite: z.boolean(),
		}),
	},
	run: async ({ ctx, next }) => {
		const canWrite = ctx.session.authenticated && ctx.session.userId === `${ctx.tenant.id}:writer`;

		return next({
			projectScope: {
				tenantId: ctx.tenant.id,
				canWrite,
			},
		});
	},
});

export const withProjectListMode = createMiddleware({
	requires: ["projectScope"],
	input: {
		query: z.object({
			status: z.enum(["active", "archived"]).optional(),
		}),
	},
	provides: {
		projectListMode: z.object({
			status: z.enum(["active", "archived"]),
			label: z.string(),
		}),
	},
	run: async ({ ctx, input, next }) => {
		const status = input.query.status ?? "active";

		return next({
			projectListMode: {
				status,
				label: `${ctx.projectScope.tenantId}:${status}`,
			},
		});
	},
});

export const withProjectPermissions = createMiddleware({
	requires: ["projectScope"],
	provides: {
		projectPermissions: z.object({
			canRead: z.boolean(),
			canWrite: z.boolean(),
		}),
	},
	run: async ({ ctx, next }) => {
		return next({
			projectPermissions: {
				canRead: true,
				canWrite: ctx.projectScope.canWrite,
			},
		});
	},
});
