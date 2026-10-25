import { createCookie } from "@routa-ts/core";
import { z } from "zod";

/** The signed demo session token that `withSession` verifies. Browser scripts cannot read it. */
export const session = createCookie({
	name: "session",
	schema: z.string(),
	httpOnly: true,
	secure: true,
	sameSite: "lax",
	path: "/",
	maxAge: 3600,
});

/** A non-secret hint that lets browser code know a session exists without reading the token. */
export const signedIn = createCookie({
	name: "signed_in",
	schema: z.literal("yes"),
	httpOnly: false,
	secure: true,
	sameSite: "lax",
	path: "/",
	maxAge: 3600,
});
