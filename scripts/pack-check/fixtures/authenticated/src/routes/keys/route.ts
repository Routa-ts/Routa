import { createRoute, createRouteRoot, requireAuth } from "@routa-ts/core";
import { z } from "zod";

export default createRouteRoot("/keys")({
	get: createRoute({
		middleware: [requireAuth({ schemes: ["serviceKey"] })],
		responses: {
			success: { status: 200, schema: z.object({ scheme: z.literal("serviceKey") }) },
		},
		run: ({ ctx }) => ({ type: "success", data: { scheme: ctx.auth.scheme } }),
	}),
});
