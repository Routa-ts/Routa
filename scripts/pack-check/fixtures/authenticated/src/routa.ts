import { apiKey, bearer, createRouta } from "@routa-ts/core";
import { z } from "zod";
import { calls } from "./calls.js";

const Principal = z.object({ type: z.enum(["user", "service"]), id: z.string() });

export default createRouta({
	port: 3000,
	authentication: {
		principal: Principal,
		schemes: {
			serviceKey: apiKey({
				header: "x-api-key",
				authenticate: (key) => {
					calls.push("serviceKey");
					return key === "smoke-key"
						? { type: "authenticated", principal: { type: "service", id: "svc_1" } }
						: { type: "rejected" };
				},
			}),
			userToken: bearer({
				challenge: { realm: "smoke" },
				authenticate: (token) => {
					calls.push("userToken");
					return token === "smoke-token"
						? { type: "authenticated", principal: { type: "user", id: "usr_1" } }
						: { type: "rejected" };
				},
			}),
		},
		priority: ["userToken", "serviceKey"],
	},
});
