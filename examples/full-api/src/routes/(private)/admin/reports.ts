import { createRoute, createRouteRoot, requireAuth } from "@routa-ts/core";
import { z } from "zod";

// A flat route nested in folders: `admin/reports.ts` maps to `/admin/reports`.
// It inherits the global context, `(private)` authentication requirement, and `admin` middleware.
const route = createRouteRoot("/admin/reports");

export default route({
	get: createRoute({
		// Report exports run from scripts, so this method accepts only an account's Bearer token.
		middleware: [requireAuth({ schemes: ["accountToken"] })],
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
				actorId: ctx.auth.principal.id,
				role: ctx.admin.role,
			},
		}),
	}),
});
