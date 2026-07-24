import { createRoute, createRouteRoot } from "@routa-ts/core";
import { z } from "zod";
import { withProjectPermissions, withProjectScope } from "../../../../../../middleware/projects.js";
import {
	DeleteProjectParams,
	GetProjectParams,
	GetProjectResponse,
	UpdateProjectBody,
	UpdateProjectParams,
	UpdateProjectResponse,
} from "./schemas.js";

const route = createRouteRoot("/tenants/:tenantId/projects/:projectId");

export default route({
	middleware: [withProjectScope],
	get: createRoute({
		input: {
			params: GetProjectParams,
		},
		responses: {
			success: {
				status: 200,
				schema: GetProjectResponse,
			},
		},
		run: ({ ctx, input }) => {
			return {
				type: "success",
				data: {
					id: input.params.projectId,
					tenantId: ctx.tenant.id,
					name: "Control Plane",
					status: "active",
				},
			};
		},
	}),
	patch: createRoute({
		middleware: [withProjectPermissions],
		input: {
			params: UpdateProjectParams,
			body: UpdateProjectBody,
		},
		responses: {
			success: {
				status: 200,
				schema: UpdateProjectResponse,
			},
		},
		run: ({ ctx, input }) => {
			return {
				type: "success",
				data: {
					id: input.params.projectId,
					tenantId: ctx.tenant.id,
					name: input.body.name ?? "Control Plane",
					status: input.body.status ?? "active",
				},
			};
		},
	}),
	delete: createRoute({
		middleware: [withProjectPermissions],
		input: {
			params: DeleteProjectParams,
		},
		responses: {
			success: {
				status: 204,
				schema: z.null(),
			},
		},
		run: () => {
			return {
				type: "success",
				data: null,
			};
		},
	}),
});
