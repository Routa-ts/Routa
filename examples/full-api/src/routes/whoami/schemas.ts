import { z } from "zod";

export const WhoAmIResponse = z.discriminatedUnion("status", [
	z.object({ status: z.literal("anonymous") }),
	z.object({
		status: z.literal("authenticated"),
		scheme: z.enum(["session", "accountToken", "serviceKey", "clientCert"]),
		principal: z.object({ type: z.enum(["account", "service"]), id: z.string() }),
	}),
]);
