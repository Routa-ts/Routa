import { createRoute, createRouteRoot } from "@routa-ts/core";
import { z } from "zod";

const route = createRouteRoot("/demo");

export default route({
	get: createRoute({
		responses: {
			success: {
				status: 200,
				schema: z.object({
					message: z.string(),
				}),
			},
		},
		run: () => {
			return { type: "success", data: { message: "Hello, world!" } };
		},
	}),
});
