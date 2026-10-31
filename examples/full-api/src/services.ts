import { defineServices } from "@routa-ts/core";

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
