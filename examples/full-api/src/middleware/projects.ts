import { createMiddleware } from "@routa-ts/core";
import { z } from "zod";
import type { TenantProjects } from "../services.js";

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
	openapi: {
		permissions: ["projects.write"],
	},
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

/** The services withProjectList reads. It needs only `list`, not the whole TenantProjects. */
export interface ProjectListRequirements {
	tenantProjects: Pick<TenantProjects, "list">;
}

const defineProjectListMiddleware = createMiddleware<ProjectListRequirements>();

/** Loads the projects for the list mode. Place it where the projects route file's services exist. */
export const withProjectList = defineProjectListMiddleware({
	requiresServices: ["tenantProjects"],
	requires: ["projectListMode"],
	provides: {
		projectList: z.array(
			z.object({
				id: z.string(),
				tenantId: z.string(),
				name: z.string(),
				status: z.enum(["active", "archived"]),
			}),
		),
	},
	run: async ({ ctx, next }) => {
		const { status, label } = ctx.projectListMode;

		return next({ projectList: ctx.services.tenantProjects.list(status, label) });
	},
});
