import { z } from "zod";
import { createMiddleware } from "../index.js";

/**
 * Creates middleware that provides an `auth` value.
 *
 * @returns Middleware that declares `auth` as a validated object.
 */
export function requireAuth() {
	return createMiddleware({
		provides: {
			auth: z.object({}),
		},
	});
}
