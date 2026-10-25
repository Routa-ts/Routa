import { createRoute, createRouteRoot } from "@routa-ts/core";
import { session, signedIn } from "../../../cookies.js";
import { verifySession } from "../../../middleware/context.js";
import { GetSessionCookies, GetSessionResponse, SignInBody, SignInRejected } from "./schemas.js";

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
	post: createRoute({
		input: {
			body: SignInBody,
		},
		responses: {
			signedIn: {
				status: 200,
				description: "The token is valid, and the session cookies are set.",
				schema: GetSessionResponse,
				cookies: [
					{ handle: session, required: true },
					{ handle: signedIn, required: true },
				],
			},
			rejected: {
				status: 401,
				description: "The token is not a valid demo session token.",
				schema: SignInRejected,
			},
		},
		run: ({ input, response }) => {
			const verified = verifySession(input.body.token);

			if (!verified.authenticated) {
				return response.rejected({ message: "Invalid session token" });
			}

			return {
				type: "signedIn",
				data: verified,
				cookies: [session.set(input.body.token), signedIn.set("yes")],
			};
		},
	}),
	delete: createRoute({
		responses: {
			signedOut: {
				status: 204,
				description: "The session cookies are cleared.",
				cookies: [
					{ handle: session, required: true },
					{ handle: signedIn, required: true },
				],
			},
		},
		run: () => ({ type: "signedOut", cookies: [session.clear(), signedIn.clear()] }),
	}),
});
