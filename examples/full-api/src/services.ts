import { defineServices, type RoutaLogger } from "@routa-ts/core";

export type ProjectStatus = "active" | "archived";

export type Project = {
	id: string;
	tenantId: string;
	name: string;
	status: ProjectStatus;
};

/** Lists and creates a tenant's projects. Routes depend on this interface, not on its store. */
export interface ProjectCatalog {
	list(tenant: { id: string; name: string }, status: ProjectStatus, label: string): Project[];
	create(tenantId: string, name: string): Project;
}

/** The services every request receives as `ctx.services`. */
export interface AppServices {
	projects: ProjectCatalog;
}

export const defineAppServices = defineServices<AppServices>();

/** Fixed showcase data. A real application would wrap its database client here. */
class DemoProjectCatalog implements ProjectCatalog {
	list(tenant: { id: string; name: string }, status: ProjectStatus, label: string): Project[] {
		const projects: Project[] = [
			{ id: "project_1", tenantId: tenant.id, name: `${tenant.name} ${label} Portal`, status },
			{ id: "project_2", tenantId: tenant.id, name: `${tenant.name} Archive`, status: "archived" },
		];

		return projects.filter((project) => project.status === status);
	}

	create(tenantId: string, name: string): Project {
		return { id: "project_new", tenantId, name, status: "active" };
	}
}

export const appServices = defineAppServices(() => ({ projects: new DemoProjectCatalog() }));

/** One tenant's projects. The projects route file builds one per request, for the tenant in ctx. */
export interface TenantProjects {
	list(status: ProjectStatus, label: string): Project[];
	create(name: string): Project;
}

/** The services the projects route file adds for each of its requests. */
export interface ProjectRouteServices {
	tenantProjects: TenantProjects;
}

export const defineProjectRouteServices = defineServices<ProjectRouteServices>();

/** Collects the projects one request creates, and logs them once the request is done. */
export class ProjectAudit {
	readonly #created: Project[] = [];

	record(project: Project): void {
		this.#created.push(project);
	}

	flush(logger: RoutaLogger): void {
		for (const project of this.#created.splice(0)) {
			logger.info("projects.created", "Project created.", { projectId: project.id });
		}
	}
}

/** The services creating a project adds for its request. */
export interface ProjectWriteServices {
	audit: Pick<ProjectAudit, "record">;
}

export const defineProjectWriteServices = defineServices<ProjectWriteServices>();
