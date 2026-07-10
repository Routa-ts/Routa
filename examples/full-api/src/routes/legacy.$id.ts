import { createRoute, defineRoute } from "@routa-ts/core";
import { z } from "zod";

// Flat dynamic route file: `legacy.$id.ts` maps to `/legacy/:id`.
export default defineRoute({
	get: createRoute({
		input: {
			params: z.object({ id: z.string() }),
		},
		responses: {
			success: {
				status: 200,
				schema: z.object({ id: z.string(), migrated: z.literal(false) }),
			},
		},
		run: ({ input }) => ({
			type: "success" as const,
			data: { id: input.params.id, migrated: false as const },
		}),
	}),
});
