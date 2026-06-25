import { createMiddleware } from "../index.js";

export function requireAuth() {
	return createMiddleware({
		provides: ["auth"],
	});
}
