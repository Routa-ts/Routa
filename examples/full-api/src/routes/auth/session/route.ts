import { createRoute, createRouteRoot } from "@routa-ts/core";
import { GetSessionCookies, GetSessionResponse } from "./schemas.js";

const route = createRouteRoot("/auth/session");

export default route({
	get: createRoute({
		input: {
			cookies: GetSessionCookies,
		},
		responses: {
			success: {
				status: 200,
				schema: GetSessionResponse,
			},
		},
		run: ({ ctx }) => {
			return {
				type: "success",
				data: ctx.session,
			};
		},
	}),
});
