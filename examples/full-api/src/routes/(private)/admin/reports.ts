import { createRoute, createRouteRoot } from "@routa-ts/core";
import { z } from "zod";

// A flat route nested in folders: `admin/reports.ts` maps to `/admin/reports`.
// It inherits the global context, `(private)` auth guard, and `admin` middleware.
const route = createRouteRoot("/admin/reports");

export default route({
	get: createRoute({
		responses: {
			success: {
				status: 200,
				schema: z.object({
					actorId: z.string(),
					role: z.literal("owner"),
				}),
			},
		},
		run: ({ ctx }) => ({
			type: "success",
			data: {
				actorId: ctx.auth.userId,
				role: ctx.admin.role,
			},
		}),
	}),
});
