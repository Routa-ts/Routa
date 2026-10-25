import { z } from "zod";

export const GetSessionCookies = z.object({ session: z.string().optional() });

export const Session = z.object({
	authenticated: z.boolean(),
	userId: z.string().optional(),
});

export const GetSessionResponse = Session;

export const SignInBody = z.object({
	token: z.string().describe("A demo token from `pnpm mint-session <userId>`"),
});

export const SignInRejected = z.object({ message: z.string() });
