import { X509Certificate } from "node:crypto";
import { apiKey, bearer, createRouta, custom, sessionCookie } from "@routa-ts/core";
import { z } from "zod";
import { createFullApiLogger } from "./logger.js";
import { appServices } from "./services.js";

const logger = process.env.ROUTA_DEMO_LOGGER === "off" ? false : createFullApiLogger();

/** Who a request can act as: a person's account, or another service. */
const Principal = z.discriminatedUnion("type", [
	z.object({ type: z.literal("account"), id: z.string() }),
	z.object({ type: z.literal("service"), id: z.string() }),
]);

export default createRouta({
	host: "127.0.0.1",
	port: 3000,
	logger,
	lifecycleHeaders: true,
	services: appServices,
	// Every credential below is a demonstration value from src/identities.ts. None is fit for production.
	authentication: {
		principal: Principal,
		schemes: {
			// The signed demo token that POST /auth/session sets, keyed by ROUTA_DEMO_SESSION_SECRET.
			session: sessionCookie({
				cookie: "session",
				authenticate: (token, { services }) => {
					const id = services.identities.accountForSession(token);
					return id
						? { type: "authenticated", principal: { type: "account", id } }
						: { type: "rejected" };
				},
			}),
			accountToken: bearer({
				challenge: { realm: "full-api" },
				authenticate: (token, { services }) => {
					const id = services.identities.accountForToken(token);
					return id
						? { type: "authenticated", principal: { type: "account", id } }
						: { type: "rejected" };
				},
			}),
			serviceKey: apiKey({
				header: "x-api-key",
				authenticate: (key, { services }) => {
					const id = services.identities.serviceForKey(key);
					return id
						? { type: "authenticated", principal: { type: "service", id } }
						: { type: "rejected" };
				},
			}),
			// A client certificate a TLS proxy verified and forwarded, percent-encoded, in a header.
			// Trust this header only behind a proxy that overwrites any copy a client sends.
			clientCert: custom({
				transport: { header: "x-client-cert" },
				openapi: {
					type: "mutualTLS",
					description: "A client certificate the TLS proxy verified.",
				},
				extract: (value) => {
					try {
						return {
							type: "credential",
							credential: new X509Certificate(decodeURIComponent(value)),
						};
					} catch {
						return { type: "malformed" };
					}
				},
				authenticate: (certificate, { services }) => {
					const id = services.identities.serviceForCertificate(certificate);
					return id
						? { type: "authenticated", principal: { type: "service", id } }
						: { type: "rejected" };
				},
			}),
		},
		// Selection and challenge order. It differs from declaration order on purpose.
		priority: ["accountToken", "session", "serviceKey", "clientCert"],
		// Two allowed credentials on one request answer 400 instead of picking one.
		multipleCredentials: "reject",
	},
});
