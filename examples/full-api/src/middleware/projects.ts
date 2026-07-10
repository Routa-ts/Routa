import { createMiddleware } from "@routa-ts/core";
import { z } from "zod";

export const withProjectScope = createMiddleware({
	requires: ["tenant", "auth"],
	provides: {
		projectScope: z.object({
			tenantId: z.string(),
			canWrite: z.boolean(),
		}),
	},
	run: async ({ ctx, next }) => {
		const canWrite = ctx.auth.userId === `${ctx.tenant.id}:writer`;

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
	rejects: {
		forbidden: {
			status: 403,
			schema: z.object({ message: z.string() }),
		},
	},
	run: async ({ ctx, next }) => {
		if (!ctx.projectScope.canWrite) {
			return {
				type: "forbidden",
				data: {
					message: "Write access required for this tenant",
				},
			};
		}

		return next({
			projectPermissions: {
				canRead: true,
				canWrite: true,
			},
		});
	},
});
