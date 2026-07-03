import { createHmac, timingSafeEqual } from "node:crypto";
import { createMiddleware } from "@routa-ts/core";
import { z } from "zod";

export const withRequest = createMiddleware({
	input: {
		headers: z.object({
			"x-request-id": z.string().optional(),
		}),
	},
	provides: {
		requestId: z.string(),
	},
	run: async ({ input, next }) => {
		return next({
			requestId: input.headers["x-request-id"] ?? "local-request",
		});
	},
});

export const withSession = createMiddleware({
	requires: ["requestId"],
	input: {
		cookies: z.object({
			session: z.string().optional(),
		}),
	},
	provides: {
		session: z.object({
			authenticated: z.boolean(),
			userId: z.string().optional(),
		}),
	},
	run: async ({ input, next }) => {
		const session = verifySession(input.cookies.session);

		return next({
			session,
		});
	},
});

const demoSessionSecret = process.env.ROUTA_DEMO_SESSION_SECRET;

function verifySession(token: string | undefined): { authenticated: boolean; userId?: string } {
	if (!token?.startsWith("demo-user:") || !demoSessionSecret) {
		return { authenticated: false };
	}

	const payload = token.slice("demo-user:".length);
	const separator = payload.lastIndexOf(".");

	if (separator === -1) {
		return { authenticated: false };
	}

	const userId = payload.slice(0, separator).trim();
	const signature = payload.slice(separator + 1);

	if (!userId || !isValidSignature(userId, signature)) {
		return { authenticated: false };
	}

	return { authenticated: true, userId };
}

function isValidSignature(userId: string, signature: string): boolean {
	const expected = createHmac("sha256", demoSessionSecret ?? "")
		.update(userId)
		.digest("base64url");

	try {
		return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
	} catch {
		return false;
	}
}
