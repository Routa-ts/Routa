import { z } from "zod";

export const GetProjectParams = z.object({
	projectId: z.string(),
	tenantId: z.string(),
});

export const Project = z.object({
	id: z.string(),
	tenantId: z.string(),
	name: z.string(),
	status: z.string(),
});

export const GetProjectResponse = Project;

export const UpdateProjectParams = z.object({
	projectId: z.string(),
	tenantId: z.string(),
});

export const UpdateProjectInput = z.object({
	name: z.string().optional(),
	status: z.enum(["active", "archived"]).optional(),
});

export const UpdateProjectBody = UpdateProjectInput;

export const UpdateProjectResponse = Project;

export const DeleteProjectParams = z.object({
	projectId: z.string(),
	tenantId: z.string(),
});
