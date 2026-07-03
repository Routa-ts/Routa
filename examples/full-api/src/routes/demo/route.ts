import { createRoute, defineRoute } from "@routa-ts/core";
import { z } from "zod";

export default defineRoute({
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
