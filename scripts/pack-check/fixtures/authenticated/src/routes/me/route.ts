import { createRoute, createRouteRoot, requireAuth } from "@routa-ts/core";
import { z } from "zod";

export default createRouteRoot("/me")({
	get: createRoute({
		middleware: [requireAuth()],
		responses: {
			success: {
				status: 200,
				schema: z.object({ scheme: z.enum(["userToken", "serviceKey"]), id: z.string() }),
			},
		},
		// ctx.auth is narrowed to the authenticated branch; tsc in routa check proves it.
		run: ({ ctx }) => ({
			type: "success",
			data: { scheme: ctx.auth.scheme, id: ctx.auth.principal.id },
		}),
	}),
});
