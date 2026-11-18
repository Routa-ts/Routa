import { createRoute, createRouteRoot } from "@routa-ts/core";
import { WhoAmIResponse } from "./schemas.js";

// A public route: Routa still authenticates any credential the request presents, so the handler
// can tell an anonymous caller from an authenticated one. An invalid credential answers 401.
const route = createRouteRoot("/whoami");

export default route({
	get: createRoute({
		responses: {
			success: {
				status: 200,
				schema: WhoAmIResponse,
			},
		},
		run: ({ ctx, response }) => {
			if (ctx.auth.status === "anonymous") {
				return response.success({ status: "anonymous" });
			}

			const { scheme, principal } = ctx.auth;
			return response.success({ status: "authenticated", scheme, principal });
		},
	}),
});
