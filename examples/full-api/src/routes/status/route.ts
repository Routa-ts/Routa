import { createRoute, createRouteRoot } from "@routa-ts/core";
import { GetStatusResponse } from "./schemas.js";

const route = createRouteRoot("/status");

export default route({
	get: createRoute({
		responses: {
			success: {
				status: 200,
				schema: GetStatusResponse,
			},
		},
		run: ({ ctx }) => {
			return {
				type: "success",
				data: {
					ok: ctx.requestId.length > 0,
					service: "full-api",
				},
			};
		},
	}),
});
