import { createHmac, timingSafeEqual } from "node:crypto";

/** Verifies a signed demo token from `scripts/mint-session.mjs`. Not an authentication scheme to copy. */
const demoSessionSecret = process.env.ROUTA_DEMO_SESSION_SECRET;

export function verifySession(token: string | undefined): {
	authenticated: boolean;
	userId?: string;
} {
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
