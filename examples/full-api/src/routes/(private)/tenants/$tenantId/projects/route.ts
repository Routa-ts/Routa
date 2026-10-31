import { createRoute, createRouteRoot } from "@routa-ts/core";
import {
	withProjectList,
	withProjectListMode,
	withProjectPermissions,
	withProjectScope,
} from "../../../../../middleware/projects.js";
import {
	defineProjectRouteServices,
	defineProjectWriteServices,
	ProjectAudit,
} from "../../../../../services.js";
import {
	CreateProjectBody,
	CreateProjectParams,
	CreateProjectResponse,
	ListProjectsHeaders,
	ListProjectsParams,
	ListProjectsQuery,
	ListProjectsResponse,
} from "./schemas.js";

const route = createRouteRoot("/tenants/:tenantId/projects");

export default route({
	// Runs per request, after the filesystem middleware resolved ctx.tenant.
	services: defineProjectRouteServices(({ ctx }) => {
		const tenant = { id: ctx.tenant.id, name: ctx.tenant.name };

		return {
			tenantProjects: {
				list: (status, label) => ctx.services.projects.list(tenant, status, label),
				create: (name) => ctx.services.projects.create(tenant.id, name),
			},
		};
	}),
	middleware: [withProjectScope],
	get: createRoute({
		// withProjectList requires tenantProjects, which the route file's factory builds before it runs.
		middleware: [withProjectListMode, withProjectList],
		input: {
			params: ListProjectsParams,
			query: ListProjectsQuery,
			headers: ListProjectsHeaders,
		},
		responses: {
			success: {
				status: 200,
				schema: ListProjectsResponse,
			},
		},
		run: ({ ctx, input }) => {
			const sorted = [...ctx.projectList].sort((left, right) => {
				const sort = input.query.sort;
				if (!sort) {
					return 0;
				}

				const leftValue = left[sort.field];
				const rightValue = right[sort.field];
				const compared = String(leftValue).localeCompare(String(rightValue));
				return sort.direction === "desc" ? -compared : compared;
			});

			// `Fields()` trims whitespace (`id, name` → ["id","name"]) before enum checks.
			const selectedFields = input.query.fields ?? (["id", "name", "status"] as const);

			return {
				type: "success",
				data: {
					projects: sorted,
					selectedFields: [...selectedFields],
				},
			};
		},
	}),
	post: createRoute({
		// Runs per POST request, after withProjectScope; logs what it recorded once the response is ready.
		services: defineProjectWriteServices(({ ctx, onCleanup }) => {
			const audit = new ProjectAudit();
			onCleanup(() => audit.flush(ctx.logger));
			return { audit };
		}),
		middleware: [withProjectPermissions],
		input: {
			params: CreateProjectParams,
			body: CreateProjectBody,
		},
		responses: {
			success: {
				status: 201,
				schema: CreateProjectResponse,
			},
		},
		run: ({ ctx, input }) => {
			const project = ctx.services.tenantProjects.create(input.body.name);
			ctx.services.audit.record(project);

			return { type: "success", data: project };
		},
	}),
});
