import { createRoute, createRouteRoot } from "@routa-ts/core";
import {
	withProjectListMode,
	withProjectPermissions,
	withProjectScope,
} from "../../../../../middleware/projects.js";
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
	middleware: [withProjectScope],
	get: createRoute({
		middleware: [withProjectListMode],
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
			const projects = ctx.services.projects.list(
				{ id: ctx.projectScope.tenantId, name: ctx.tenant.name },
				ctx.projectListMode.status,
				ctx.projectListMode.label,
			);

			const sorted = [...projects].sort((left, right) => {
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
			return {
				type: "success",
				data: ctx.services.projects.create(ctx.projectScope.tenantId, input.body.name),
			};
		},
	}),
});
