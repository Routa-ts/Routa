import { createRoute, createRouteRoot } from "@routa-ts/core";
import { z } from "zod";
import { calls } from "../../calls.js";

export default createRouteRoot("/calls")({
	get: createRoute({
		responses: { success: { status: 200, schema: z.object({ calls: z.array(z.string()) }) } },
		run: () => ({ type: "success", data: { calls: calls.splice(0) } }),
	}),
});
