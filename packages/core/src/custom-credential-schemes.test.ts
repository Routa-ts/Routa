import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { createHonoApp, type HonoRoute } from "./hono.js";
import {
	apiKey,
	bearer,
	createRoute,
	createRouta,
	custom,
	requireAuth,
	sessionCookie,
} from "./index.js";
import { createLogger, type RoutaLogEvent } from "./logger.js";

const Principal = z.discriminatedUnion("type", [
	z.object({ type: z.literal("user"), id: z.string() }),
	z.object({ type: z.literal("service"), id: z.string() }),
]);

/** Decodes `Authorization: Basic` credentials, or reports them malformed. */
function decodeBasic(value: string) {
	const decoded = atob(value);
	const index = decoded.indexOf(":");
	return index === -1
		? ({ type: "malformed" } as const)
		: ({
				type: "credential",
				credential: { user: decoded.slice(0, index), password: decoded.slice(index + 1) },
			} as const);
}

const basic = (user: string, password: string) => `Basic ${btoa(`${user}:${password}`)}`;

/**
 * Configures a Bearer scheme and an HTTP Basic custom scheme, recording what each extractor and
 * authenticator receives.
 */
function configured(options: { priority?: readonly string[]; strict?: boolean } = {}) {
	const calls: unknown[] = [];
	const authentication = {
		principal: Principal,
		schemes: {
			userToken: bearer({
				authenticate: (token) => {
					calls.push(["userToken", token]);
					return token === "user-token"
						? { type: "authenticated" as const, principal: { type: "user" as const, id: "user_1" } }
						: { type: "rejected" as const };
				},
			}),
			basicUser: custom({
				transport: { header: "authorization", scheme: "Basic" },
				challenge: { scheme: "Basic", realm: "api" },
				openapi: { type: "http", scheme: "basic" },
				extract: (value) => {
					calls.push(["extract", value]);
					return decodeBasic(value);
				},
				authenticate: (credential) => {
					calls.push(["basicUser", credential]);
					return credential.user === "ada" && credential.password === "secret"
						? {
								type: "authenticated" as const,
								principal: { type: "user" as const, id: "user_ada" },
							}
						: { type: "rejected" as const };
				},
			}),
		},
		...(options.priority && { priority: options.priority }),
		...(options.strict && { multipleCredentials: "reject" as const }),
	};
	return { authentication, calls };
}

function whoami(middleware: readonly unknown[] = []): HonoRoute {
	return {
		method: "get",
		path: "/whoami",
		contract: createRoute({
			middleware: middleware as never,
			responses: { ok: { status: 200, schema: z.object({ auth: z.unknown() }) } },
			run: ({ ctx }) => ({ type: "ok", data: { auth: (ctx as { auth?: unknown }).auth } }),
		}),
	};
}

async function send(
	route: HonoRoute,
	setup: { authentication: unknown; calls: unknown[] },
	headers: HeadersInit,
	logger?: ReturnType<typeof createLogger>,
) {
	const app = createHonoApp([route], {
		authentication: setup.authentication as never,
		...(logger && { logger }),
	});
	const response = await app.request("/whoami", { headers });
	const text = await response.text();
	return {
		status: response.status,
		challenge: response.headers.get("www-authenticate"),
		body: text ? JSON.parse(text) : undefined,
		calls: setup.calls,
	};
}

const failedBody = {
	type: "https://routa-ts.dev/problems/authentication-failed",
	title: "Authentication failed",
	status: 401,
};

describe("a custom credential scheme", () => {
	it("extracts the declared value, authenticates the extracted credential, and types ctx.auth", async () => {
		const result = await send(whoami(), configured(), {
			authorization: basic("ada", "secret"),
		});

		expect(result).toEqual({
			status: 200,
			challenge: null,
			body: {
				auth: {
					status: "authenticated",
					scheme: "basicUser",
					principal: { type: "user", id: "user_ada" },
				},
			},
			calls: [
				["extract", btoa("ada:secret")],
				["basicUser", { user: "ada", password: "secret" }],
			],
		});
	});

	it("reads the Authorization auth-scheme case-insensitively, and leaves Bearer to bearer()", async () => {
		const lower = await send(whoami(), configured(), {
			authorization: `basic ${btoa("ada:secret")}`,
		});
		expect(lower.body.auth.scheme).toBe("basicUser");

		const bearerToken = await send(whoami(), configured(), { authorization: "Bearer user-token" });
		expect(bearerToken.body.auth.scheme).toBe("userToken");
		expect(bearerToken.calls).toEqual([["userToken", "user-token"]]);
	});

	it("stays anonymous without the transport and runs nothing", async () => {
		const result = await send(whoami(), configured(), { "x-other": "1" });

		expect(result).toEqual({
			status: 200,
			challenge: null,
			body: { auth: { status: "anonymous" } },
			calls: [],
		});
	});

	it("fails a malformed extraction without calling the authenticator", async () => {
		const result = await send(whoami(), configured(), {
			authorization: `Basic ${btoa("no-colon")}`,
		});

		expect(result).toEqual({
			status: 401,
			challenge: 'Basic realm="api"',
			body: failedBody,
			calls: [["extract", btoa("no-colon")]],
		});
	});

	it("fails an empty or repeated value before extraction", async () => {
		for (const authorization of ["Basic", "Basic a, Basic b"]) {
			const result = await send(whoami(), configured(), { authorization });
			expect(result, authorization).toEqual({
				status: 401,
				challenge: 'Basic realm="api"',
				body: failedBody,
				calls: [],
			});
		}
	});

	it("fails a rejected credential with the scheme's challenge and no failure detail", async () => {
		const result = await send(whoami(), configured(), { authorization: basic("ada", "wrong") });

		expect(result).toEqual({
			status: 401,
			challenge: 'Basic realm="api"',
			body: failedBody,
			calls: [
				["extract", btoa("ada:wrong")],
				["basicUser", { user: "ada", password: "wrong" }],
			],
		});
	});

	it("challenges every allowed scheme in priority order when a protected route gets no credential", async () => {
		const result = await send(
			whoami([requireAuth()]),
			configured({ priority: ["basicUser", "userToken"] }),
			{},
		);

		expect(result.status).toBe(401);
		expect(result.challenge).toBe('Basic realm="api", Bearer');
	});

	it("passes the raw value through without an extractor, and challenges with the scheme name", async () => {
		const received: unknown[] = [];
		const setup = {
			calls: received,
			authentication: {
				principal: Principal,
				schemes: {
					clientCert: custom({
						transport: { header: "x-client-cert" },
						openapi: { type: "mutualTLS" },
						authenticate: (certificate) => {
							const value: string = certificate;
							received.push(value);
							return value === "cert%20pem"
								? { type: "authenticated", principal: { type: "service", id: "svc_cert" } }
								: { type: "rejected" };
						},
					}),
				},
			},
		};

		expect(await send(whoami(), setup, { "x-client-cert": "cert%20pem" })).toMatchObject({
			status: 200,
			body: { auth: { scheme: "clientCert", principal: { id: "svc_cert" } } },
		});
		expect(await send(whoami(), setup, { "x-client-cert": "other" })).toMatchObject({
			status: 401,
			challenge: "clientCert",
		});
		expect(await send(whoami([requireAuth()]), setup, {})).toMatchObject({
			status: 401,
			challenge: "clientCert",
		});
		expect(received).toEqual(["cert%20pem", "other"]);
	});

	it("reads one cookie as session cookies are read", async () => {
		const setup = {
			calls: [],
			authentication: {
				principal: Principal,
				schemes: {
					userToken: bearer({ authenticate: () => ({ type: "rejected" }) }),
					device: custom({
						transport: { cookie: "device" },
						openapi: {
							type: "apiKey",
							in: "cookie",
							name: "device",
							description: "A device cookie.",
						},
						extract: (value) =>
							value.startsWith("d_")
								? { type: "credential", credential: value.slice(2) }
								: { type: "malformed" },
						authenticate: (id) =>
							id === "42"
								? { type: "authenticated", principal: { type: "service", id: `device_${id}` } }
								: { type: "rejected" },
					}),
				},
			},
		};

		expect(await send(whoami(), setup, { cookie: "theme=dark; device=d_42" })).toMatchObject({
			status: 200,
			body: { auth: { scheme: "device", principal: { id: "device_42" } } },
		});
		expect(await send(whoami(), setup, { cookie: "device=d_42; device=d_43" })).toMatchObject({
			status: 401,
			challenge: "device",
		});
		expect(await send(whoami(), setup, { cookie: "device=42" })).toMatchObject({
			status: 401,
			challenge: "device",
		});
	});
});

describe("custom schemes in credential selection", () => {
	const both = { authorization: basic("ada", "secret") };

	it("treats an Authorization auth-scheme a custom scheme reads as supported", async () => {
		const unsupported = await send(whoami(), configured(), { authorization: "Digest abc" });
		expect(unsupported).toMatchObject({ status: 401, challenge: 'Bearer, Basic realm="api"' });
	});

	it("selects by priority among a custom credential and a built-in one", async () => {
		const calls: unknown[] = [];
		const setup = {
			calls,
			authentication: {
				principal: Principal,
				schemes: {
					serviceKey: apiKey({
						header: "x-api-key",
						authenticate: (key) => {
							calls.push(["serviceKey", key]);
							return { type: "authenticated", principal: { type: "service", id: "svc_1" } };
						},
					}),
					clientCert: custom({
						transport: { header: "x-client-cert" },
						openapi: { type: "mutualTLS" },
						authenticate: (certificate) => {
							calls.push(["clientCert", certificate]);
							return { type: "authenticated", principal: { type: "service", id: "svc_cert" } };
						},
					}),
				},
				priority: ["clientCert", "serviceKey"],
			},
		};
		const result = await send(whoami(), setup, { "x-api-key": "k", "x-client-cert": "c" });
		expect(result.body.auth.scheme).toBe("clientCert");
		expect(calls).toEqual([["clientCert", "c"]]);

		calls.length = 0;
		const strict = await send(
			whoami(),
			{ ...setup, authentication: { ...setup.authentication, multipleCredentials: "reject" } },
			{ "x-api-key": "k", "x-client-cert": "c" },
		);
		expect(strict.status).toBe(400);
		expect(calls).toEqual([]);
	});

	it("narrows a protected route to the custom scheme", async () => {
		const route = whoami([requireAuth({ schemes: ["basicUser"] as never })]);

		const onlyBearer = await send(route, configured(), { authorization: "Bearer user-token" });
		expect(onlyBearer).toMatchObject({ status: 401, challenge: 'Basic realm="api"', calls: [] });

		const accepted = await send(route, configured(), both);
		expect(accepted).toMatchObject({ status: 200, body: { auth: { scheme: "basicUser" } } });

		const missing = await send(route, configured(), {});
		expect(missing).toMatchObject({ status: 401, challenge: 'Basic realm="api"' });
	});
});

describe("custom scheme failures", () => {
	function failing(
		extract: (value: string) => unknown,
		authenticate: (credential: any) => unknown = () => ({ type: "rejected" }),
	) {
		return {
			calls: [] as unknown[],
			authentication: {
				principal: Principal,
				schemes: {
					signed: custom({
						transport: { header: "x-signed" },
						openapi: { type: "apiKey", in: "header", name: "x-signed" },
						extract: extract as never,
						authenticate: authenticate as never,
					}),
				},
			},
		};
	}

	async function logged(setup: ReturnType<typeof failing>) {
		const events: RoutaLogEvent[] = [];
		const result = await send(
			whoami(),
			setup,
			{ "x-signed": "secret-credential-value" },
			createLogger({ sink: (event) => events.push(event) }),
		);
		return { status: result.status, logs: JSON.stringify(events) };
	}

	it("answers 500 for a throwing extractor and logs only the scheme", async () => {
		const { status, logs } = await logged(
			failing((value) => {
				throw new Error(`provider could not parse ${value}`);
			}),
		);

		expect(status).toBe(500);
		expect(logs).toContain('Credential extraction for scheme \\"signed\\" threw.');
		expect(logs).not.toContain("secret-credential-value");
		expect(logs).not.toContain("provider could not parse");
	});

	it("answers 500 for an extractor result that is neither a credential nor malformed", async () => {
		for (const result of [
			undefined,
			{ type: "ok" },
			Promise.resolve({ type: "malformed" }),
			{ credential: "x" },
		]) {
			const { status, logs } = await logged(failing(() => result));
			expect(status).toBe(500);
			expect(logs).toContain("AuthenticationContractError");
			expect(logs).not.toContain("secret-credential-value");
		}
	});

	it("answers 500 for an extractor promise and observes its rejection", async () => {
		const unhandled: unknown[] = [];
		const listener = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", listener);

		try {
			const { status, logs } = await logged(
				failing(async () => {
					throw new Error("provider could not parse secret-credential-value");
				}),
			);
			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(status).toBe(500);
			expect(logs).toContain("AuthenticationContractError");
			expect(logs).not.toContain("secret-credential-value");
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", listener);
		}
	});

	it("keeps authenticator throws and invalid principals as distinct server errors", async () => {
		const extract = (value: string) => ({ type: "credential", credential: value });
		const thrown = await logged(
			failing(extract, () => {
				throw new Error("provider down secret-credential-value");
			}),
		);
		expect(thrown.status).toBe(500);
		expect(thrown.logs).toContain('Authenticator for scheme \\"signed\\" threw.');
		expect(thrown.logs).not.toContain("secret-credential-value");

		const invalid = await logged(
			failing(extract, () => ({ type: "authenticated", principal: { type: "admin", id: "a" } })),
		);
		expect(invalid.status).toBe(500);
		expect(invalid.logs).toContain("does not match the principal schema");
	});

	it("gives the extractor the declared value alone and keeps contract facts out of its reach", async () => {
		const received: unknown[][] = [];
		const transport = { header: "x-signed" };
		const openapi = { type: "apiKey" as const, in: "header" as const, name: "x-signed" };
		const signed = custom({
			transport,
			openapi,
			extract: (...args: [string]) => {
				received.push(args);
				return { type: "malformed" };
			},
			authenticate: () => ({ type: "rejected" }),
		});
		transport.header = "x-other";
		openapi.name = "x-other";

		expect(Object.isFrozen(signed)).toBe(true);
		expect(Object.isFrozen(signed.transport)).toBe(true);
		expect(signed.transport).toEqual({ header: "x-signed" });
		expect(signed.openapi).toEqual({ type: "apiKey", in: "header", name: "x-signed" });

		const setup = { calls: [], authentication: { principal: Principal, schemes: { signed } } };
		expect(await send(whoami(), setup, { "x-signed": "value", "x-other": "o" })).toMatchObject({
			status: 401,
			challenge: "signed",
		});
		expect(received).toEqual([["value"]]);
	});

	it("calls the extractor and authenticator without a receiver they could change", async () => {
		const receivers: unknown[] = [];
		const signed = custom({
			transport: { header: "x-signed" },
			openapi: { type: "apiKey", in: "header", name: "x-signed" },
			extract(this: unknown, value) {
				receivers.push(this);
				const scheme = this as { transport?: { header: string }; challenge?: string } | undefined;
				if (scheme?.transport) {
					scheme.transport.header = "x-attacker";
					scheme.challenge = value;
				}
				return { type: "credential", credential: value };
			},
			authenticate(this: unknown) {
				receivers.push(this);
				return { type: "rejected" };
			},
		});
		const setup = { calls: [], authentication: { principal: Principal, schemes: { signed } } };

		const first = await send(whoami(), setup, { "x-signed": "secret-value" });
		const second = await send(whoami(), setup, { "x-signed": "secret-value" });

		expect(receivers).toEqual([undefined, undefined, undefined, undefined]);
		expect([first.status, first.challenge]).toEqual([401, "signed"]);
		expect([second.status, second.challenge]).toEqual([401, "signed"]);
	});

	it("ignores an extract member on a built-in scheme", async () => {
		const received: unknown[] = [];
		const token = bearer({
			authenticate: (value) => {
				received.push(value);
				return { type: "authenticated", principal: { type: "user", id: value } };
			},
		});
		const extract = () => ({ type: "credential", credential: { id: "not-a-token" } });
		const setup = {
			calls: [],
			authentication: { principal: Principal, schemes: { token: { ...token, extract } } },
		};

		const result = await send(whoami(), setup, { authorization: "Bearer user-token" });

		expect(result).toMatchObject({ status: 200, body: { auth: { scheme: "token" } } });
		expect(received).toEqual(["user-token"]);
	});

	it("gives the authenticator the extracted credential, not the extractor's result object", async () => {
		const received: unknown[] = [];
		const result = { type: "credential", credential: { id: "c1" } };
		const setup = failing(
			() => result,
			(credential: unknown) => {
				received.push(credential);
				return { type: "rejected" };
			},
		);
		expect((await logged(setup)).status).toBe(401);
		expect(received).toEqual([{ id: "c1" }]);
		expect(received[0]).toBe(result.credential);
	});
});

describe("custom scheme configuration", () => {
	const reject = () => ({ type: "rejected" }) as const;
	const header = (name: string, scheme?: string) =>
		custom({
			transport: scheme === undefined ? { header: name } : { header: name, scheme },
			openapi:
				scheme === undefined ? { type: "apiKey", in: "header", name } : { type: "http", scheme },
			authenticate: reject,
		});
	const cookie = (name: string) =>
		custom({
			transport: { cookie: name },
			openapi: { type: "apiKey", in: "cookie", name },
			authenticate: reject,
		});
	const token = bearer({ authenticate: reject });

	it("rejects transports another scheme already reads", () => {
		const cases: Array<[Record<string, unknown>, string]> = [
			[
				{ a: token, b: header("Authorization", "bearer") },
				'schemes "a" and "b" both read the Authorization Bearer credential.',
			],
			[
				{ a: token, b: header("authorization") },
				'schemes "a" and "b" both read the Authorization Bearer credential.',
			],
			[
				{ a: header("authorization", "Basic"), b: header("Authorization") },
				'schemes "a" and "b" both read the Authorization Basic credential.',
			],
			[
				{ a: header("authorization", "Basic"), b: header("Authorization", "BASIC") },
				'schemes "a" and "b" both read the Authorization Basic credential.',
			],
			[
				{ a: header("X-Client-Cert"), b: header("x-client-cert") },
				'schemes "a" and "b" both read the x-client-cert header.',
			],
			[
				{ a: apiKey({ header: "x-api-key", authenticate: reject }), b: header("X-Api-Key") },
				'schemes "a" and "b" both read the x-api-key header.',
			],
			[
				{ a: sessionCookie({ cookie: "sid", authenticate: reject }), b: cookie("sid") },
				'schemes "a" and "b" both read the "sid" cookie.',
			],
			[
				{ a: cookie("sid"), b: header("Cookie") },
				'schemes "a" and "b" both read the "sid" cookie.',
			],
		];

		for (const [schemes, message] of cases) {
			expect(
				() =>
					createHonoApp([whoami()], { authentication: { principal: Principal, schemes } as never }),
				message,
			).toThrow(message);
		}

		expect(() =>
			createHonoApp([whoami()], {
				authentication: {
					principal: Principal,
					schemes: {
						a: token,
						b: header("authorization", "Basic"),
						c: header("cookie"),
						d: cookie("other"),
					},
				} as never,
			}),
		).toThrow('schemes "c" and "d" both read the "other" cookie.');
		expect(() =>
			createHonoApp([whoami()], {
				authentication: {
					principal: Principal,
					schemes: {
						a: token,
						b: header("authorization", "Basic"),
						c: header("x-a"),
						d: cookie("sid"),
					},
				} as never,
			}),
		).not.toThrow();
	});

	it("validates the transport, challenge, OpenAPI metadata, and functions", () => {
		const options = {
			transport: { header: "x-signed" },
			openapi: { type: "apiKey", in: "header", name: "x-signed" },
			authenticate: reject,
		};
		const cases: Array<[Record<string, unknown>, string]> = [
			[
				{ transport: undefined },
				'transport must be { header: "x-name" }, { header: "authorization", scheme: "Basic" }, or { cookie: "name" }.',
			],
			[
				{ transport: { header: "x-a", cookie: "a" } },
				'transport must be { header: "x-name" }, { header: "authorization", scheme: "Basic" }, or { cookie: "name" }.',
			],
			[
				{ transport: { header: "x a" } },
				'transport header must be an HTTP header name, such as "x-client-cert".',
			],
			[{ transport: { cookie: "a;b" } }, 'transport cookie must be a cookie name, such as "sid".'],
			[
				{ transport: { header: "x-a", scheme: "Basic" } },
				"transport scheme applies only to the Authorization header.",
			],
			[
				{ transport: { header: "authorization", scheme: "Ba sic" } },
				'transport scheme must be an HTTP auth-scheme, such as "Basic".',
			],
			[
				{ challenge: { scheme: "Ba sic" } },
				'challenge scheme must be an HTTP auth-scheme, such as "Basic".',
			],
			[
				{ challenge: { error: "x" } },
				'challenge declares "error". A custom challenge override accepts only scheme and realm.',
			],
			[
				{ challenge: { realm: 'a"b' } },
				'challenge realm must be a non-empty string of printable ASCII without " or \\.',
			],
			[
				{ openapi: undefined },
				'openapi must describe the public security scheme, such as { type: "http", scheme: "basic" }.',
			],
			[{ openapi: { type: "oauth2" } }, 'openapi type must be "http", "apiKey", or "mutualTLS".'],
			[
				{ openapi: { type: "http", scheme: "basic" } },
				'openapi { type: "http" } needs an { header: "authorization", scheme } transport whose scheme is "basic".',
			],
			[
				{
					transport: { header: "authorization", scheme: "Basic" },
					openapi: { type: "http", scheme: "digest" },
				},
				'openapi { type: "http" } needs an { header: "authorization", scheme } transport whose scheme is "digest".',
			],
			[
				{
					transport: { header: "authorization", scheme: "Basic" },
					openapi: { type: "http", scheme: "basic", bearerFormat: "JWT" },
				},
				'openapi bearerFormat applies only to scheme "bearer".',
			],
			[
				{ openapi: { type: "apiKey", in: "header", name: "x-other" } },
				'openapi { type: "apiKey" } must name the transport: in: "header", name: "x-signed".',
			],
			[
				{ openapi: { type: "apiKey", in: "cookie", name: "x-signed" } },
				'openapi { type: "apiKey" } must name the transport: in: "header", name: "x-signed".',
			],
			[
				{ transport: { cookie: "sid" }, openapi: { type: "mutualTLS" } },
				'openapi { type: "mutualTLS" } needs a header transport other than Authorization, such as a trusted proxy\'s client-certificate header.',
			],
			[
				{ openapi: { type: "apiKey", in: "header", name: "x-signed", scopes: [] } },
				'openapi declares "scopes", which { type: "apiKey" } does not accept.',
			],
			[{ openapi: { type: "mutualTLS", description: 1 } }, "openapi description must be a string."],
			[{ extract: "decode" }, "custom() extract must be a function when present."],
			[{ authenticate: undefined }, "custom() needs an authenticate function."],
		];

		for (const [override, message] of cases) {
			expect(() => custom({ ...options, ...override } as never), message).toThrow(message);
		}

		expect(() =>
			createHonoApp([whoami()], {
				authentication: {
					principal: Principal,
					schemes: { a: { kind: "custom", transport: { header: "x a" }, authenticate: reject } },
				} as never,
			}),
		).toThrow('scheme "a" transport header must be an HTTP header name, such as "x-client-cert".');
	});
});

/** Type fixtures: compiled, never run. */
function typesOnly(_check: () => void): void {}

describe("custom credential schemes (types)", () => {
	it("flows the extracted credential type into the authenticator and checks scheme names", () => {
		typesOnly(() => {
			custom({
				transport: { header: "authorization", scheme: "Basic" },
				openapi: { type: "http", scheme: "basic" },
				extract: (value) => decodeBasic(value),
				authenticate: (credential) => {
					const user: string = credential.user;
					// @ts-expect-error The credential is what extract returns, not a string.
					const raw: string = credential;
					void raw;
					return user === "ada"
						? { type: "authenticated", principal: { type: "user", id: user } }
						: { type: "rejected" };
				},
			});

			custom({
				transport: { cookie: "sid" },
				openapi: { type: "apiKey", in: "cookie", name: "sid" },
				authenticate: (value) => {
					const raw: string = value;
					return raw ? { type: "rejected" } : { type: "rejected" };
				},
			});

			const basicUser = custom({
				transport: { header: "authorization", scheme: "Basic" },
				openapi: { type: "http", scheme: "basic" },
				extract: (value) => decodeBasic(value),
				authenticate: () => ({ type: "rejected" }),
			});

			createRouta({
				authentication: {
					principal: Principal,
					schemes: { userToken: bearer({ authenticate: () => ({ type: "rejected" }) }), basicUser },
					priority: ["basicUser", "userToken"],
				},
			});

			createRouta({
				authentication: {
					principal: Principal,
					schemes: { userToken: bearer({ authenticate: () => ({ type: "rejected" }) }), basicUser },
					// @ts-expect-error priority lists only configured scheme names.
					priority: ["basicUsr", "userToken"],
				},
			});

			createRouta({
				authentication: {
					principal: Principal,
					schemes: {
						// @ts-expect-error "admin" is not a principal type the schema accepts.
						device: custom({
							transport: { cookie: "device" },
							openapi: { type: "apiKey", in: "cookie", name: "device" },
							authenticate: () => ({
								type: "authenticated",
								principal: { type: "admin", id: "a" },
							}),
						}),
					},
				},
			});

			custom({
				transport: { header: "x-signed" },
				openapi: { type: "mutualTLS" },
				// @ts-expect-error extract receives only the declared value.
				extract: (value: string, request: Request) => ({
					type: "credential",
					credential: [value, request],
				}),
				authenticate: () => ({ type: "rejected" }),
			});

			custom({
				transport: { header: "x-signed" },
				openapi: { type: "mutualTLS" },
				// @ts-expect-error extract is synchronous.
				extract: async (value: string) => ({ type: "credential", credential: value }),
				authenticate: () => ({ type: "rejected" }),
			});

			// @ts-expect-error A custom scheme declares public OpenAPI metadata.
			custom({ transport: { header: "x-signed" }, authenticate: () => ({ type: "rejected" }) });
		});
	});
});
