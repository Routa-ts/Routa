import { z } from "zod";
import { createMiddleware } from "../index.js";

export function requireAuth() {
	return createMiddleware({
		provides: {
			auth: z.object({}),
		},
	});
}
