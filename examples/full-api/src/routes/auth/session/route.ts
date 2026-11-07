import { createRoute, createRouteRoot } from "@routa-ts/core";
import { sessionCookie, signedInCookie } from "../../../cookies.js";
import { verifySession } from "../../../session.js";
import { SignedIn, SignInBody, SignInRejected } from "./schemas.js";

// Sign-in and sign-out run under automatic authentication like every route, so a request that
// still carries an invalid session cookie answers 401 before either handler runs.
const route = createRouteRoot("/auth/session");

export default route({
	post: createRoute({
		input: {
			body: SignInBody,
		},
		responses: {
			signedIn: {
				status: 200,
				description: "The token is valid, and the session cookies are set.",
				schema: SignedIn,
				cookies: [
					{ handle: sessionCookie, required: true },
					{ handle: signedInCookie, required: true },
				],
			},
			rejected: {
				status: 401,
				description: "The token is not a valid demo session token.",
				schema: SignInRejected,
			},
		},
		run: ({ input, response }) => {
			const accountId = verifySession(input.body.token).userId;

			if (!accountId) {
				return response.rejected({
					type: "https://full-api.example.invalid/problems/invalid-sign-in-token",
					message: "Invalid session token",
				});
			}

			return {
				type: "signedIn",
				data: { accountId },
				cookies: [sessionCookie.set(input.body.token), signedInCookie.set("yes")],
			};
		},
	}),
	delete: createRoute({
		responses: {
			signedOut: {
				status: 204,
				description: "The session cookies are cleared.",
				cookies: [
					{ handle: sessionCookie, required: true },
					{ handle: signedInCookie, required: true },
				],
			},
		},
		run: () => ({ type: "signedOut", cookies: [sessionCookie.clear(), signedInCookie.clear()] }),
	}),
});
