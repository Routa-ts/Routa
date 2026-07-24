import { createRoute, createRouteRoot } from "@routa-ts/core";
import { z } from "zod";

// Flat dynamic route file: `legacy.$id.ts` maps to `/legacy/:id`.
const route = createRouteRoot("/legacy/:id");

export default route({
	get: createRoute({
		deprecation: {
			sunset: "2027-06-01",
			replacement: "https://api.example.invalid/migrations/legacy-projects",
		},
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
