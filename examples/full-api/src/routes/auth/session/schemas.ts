import { z } from "zod";

export const SignInBody = z.object({
	token: z.string().describe("A demo token from `pnpm mint-session <userId>`"),
});

export const SignedIn = z.object({ accountId: z.string() });

// The `type` literal tells this 401 apart from Routa's `authenticationFailed`, which the same
// operation can answer when the request carries an invalid credential.
export const SignInRejected = z.object({
	type: z.literal("https://full-api.example.invalid/problems/invalid-sign-in-token"),
	message: z.string(),
});
