import { createRoute, createRouteRoot } from "@routa-ts/core";

export default createRouteRoot("/boom")({
	get: createRoute({
		responses: { ok: { status: 200 } },
		run: () => {
			throw new Error("db password=identity-smoke-secret rejected");
		},
	}),
});
