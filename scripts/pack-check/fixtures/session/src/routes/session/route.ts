import { createCookie, createRoute, createRouteRoot } from "@routa-ts/core";
import { z } from "zod";

const session = createCookie({
	name: "session",
	schema: z.string(),
	httpOnly: true,
	secure: true,
	sameSite: "lax",
	path: "/",
});

const theme = createCookie({
	name: "theme",
	schema: z.enum(["light", "dark"]),
	httpOnly: false,
	secure: true,
	sameSite: "lax",
	path: "/",
});

export default createRouteRoot("/session")({
	post: createRoute({
		responses: {
			created: {
				status: 201,
				schema: z.object({ id: z.string() }),
				headers: z.object({ location: z.string() }),
				cookies: [session, theme],
			},
		},
		run: () => ({
			type: "created",
			data: { id: "s_1" },
			headers: { location: "/session" },
			cookies: [session.set("a b"), theme.set("dark")],
		}),
	}),
	delete: createRoute({
		responses: { deleted: { status: 204, cookies: [{ handle: session, required: true }] } },
		run: () => ({ type: "deleted", cookies: [session.clear()] }),
	}),
});
