import { createRoute, createRouteRoot } from "@routa-ts/core";
import { z } from "zod";

export default createRouteRoot("/whoami")({
	get: createRoute({
		responses: {
			success: { status: 200, schema: z.object({ status: z.string(), id: z.string().optional() }) },
		},
		run: ({ ctx }) => ({
			type: "success",
			data:
				ctx.auth.status === "anonymous"
					? { status: "anonymous" }
					: { status: "authenticated", id: ctx.auth.principal.id },
		}),
	}),
});
