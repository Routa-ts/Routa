import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { createHonoApp, type HonoRoute } from "./hono.js";
import { apiKey, bearer, createRoute, createRouta, requireAuth, sessionCookie } from "./index.js";
import { createLogger, type RoutaLogEvent } from "./logger.js";

const Principal = z.discriminatedUnion("type", [
	z.object({ type: z.literal("user"), id: z.string() }),
	z.object({ type: z.literal("service"), id: z.string() }),
]);

/** Configures Bearer, API-key, and session schemes and records which authenticators run. */
function configured(options: { priority?: readonly string[]; strict?: boolean } = {}) {
	const calls: string[] = [];
	const accept =
		(scheme: string, valid: string, principal: { type: "user" | "service"; id: string }) =>
		(credential: string) => {
			calls.push(scheme);
			return credential === valid
				? { type: "authenticated" as const, principal }
				: { type: "rejected" as const };
		};
	const authentication = {
		principal: Principal,
		schemes: {
			userToken: bearer({ authenticate: accept("userToken", "user-token", userPrincipal) }),
			serviceKey: apiKey({
				header: "X-Api-Key",
				authenticate: accept("serviceKey", "service-key", { type: "service", id: "svc_1" }),
			}),
			session: sessionCookie({
				cookie: "session",
				authenticate: accept("session", "session-id", { type: "user", id: "user_2" }),
			}),
		},
		...(options.priority && { priority: options.priority }),
		...(options.strict && { multipleCredentials: "reject" as const }),
	};
	return { authentication, calls };
}

const userPrincipal = { type: "user", id: "user_1" } as const;

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

const headRoute: HonoRoute = {
	method: "head",
	path: "/whoami",
	contract: createRoute({ responses: { ok: { status: 200 } }, run: () => ({ type: "ok" }) }),
};

const credentials = {
	bearer: { authorization: "Bearer user-token" },
	apiKey: { "x-api-key": "service-key" },
	session: { cookie: "theme=dark; session=session-id" },
} as const;

const failedBody = {
	type: "https://routa-ts.dev/problems/authentication-failed",
	title: "Authentication failed",
	status: 401,
};

const ambiguousBody = {
	type: "https://routa-ts.dev/problems/ambiguous-credentials",
	title: "Ambiguous credentials",
	status: 400,
};

async function send(route: HonoRoute, setup: ReturnType<typeof configured>, headers: HeadersInit) {
	const response = await createHonoApp([route], { authentication: setup.authentication }).request(
		"/whoami",
		{ method: route.method.toUpperCase(), headers },
	);
	const text = await response.text();
	return {
		status: response.status,
		challenge: response.headers.get("www-authenticate"),
		body: text ? JSON.parse(text) : undefined,
		calls: setup.calls,
	};
}

describe("API-key and session-cookie schemes", () => {
	it("authenticates each valid credential through its own authenticator", async () => {
		for (const [headers, scheme, principal] of [
			[credentials.bearer, "userToken", userPrincipal],
			[credentials.apiKey, "serviceKey", { type: "service", id: "svc_1" }],
			[credentials.session, "session", { type: "user", id: "user_2" }],
		] as const) {
			const result = await send(whoami(), configured(), headers);

			expect(result).toEqual({
				status: 200,
				challenge: null,
				body: { auth: { status: "authenticated", scheme, principal } },
				calls: [scheme],
			});
		}
	});

	it("passes the session authenticator the percent-decoded cookie value", async () => {
		const result = await send(whoami(), configured(), { cookie: "session=session%2Did" });

		expect(result).toEqual({
			status: 200,
			challenge: null,
			body: {
				auth: {
					status: "authenticated",
					scheme: "session",
					principal: { type: "user", id: "user_2" },
				},
			},
			calls: ["session"],
		});
	});

	it("stays anonymous without a credential, ignoring unrelated cookies and headers", async () => {
		const result = await send(whoami(), configured(), { cookie: "theme=dark", "x-other": "1" });

		expect(result).toEqual({
			status: 200,
			challenge: null,
			body: { auth: { status: "anonymous" } },
			calls: [],
		});
	});

	const invalid: Array<[string, HeadersInit, string, string[]]> = [
		["a rejected API key", { "x-api-key": "wrong" }, "ApiKey", ["serviceKey"]],
		["an empty API key", { "x-api-key": "" }, "ApiKey", []],
		[
			"a repeated API-key header",
			[
				["x-api-key", "a"],
				["x-api-key", "b"],
			],
			"ApiKey",
			[],
		],
		["an API key with a comma", { "x-api-key": "a,b" }, "ApiKey", []],
		["a rejected session", { cookie: "session=wrong" }, "Session", ["session"]],
		["an empty session cookie", { cookie: "session=" }, "Session", []],
		["a repeated session cookie", { cookie: "session=a; session=session-id" }, "Session", []],
	];

	for (const [label, headers, challenge, calls] of invalid) {
		it(`fails closed for ${label} on public and protected routes`, async () => {
			for (const route of [whoami(), whoami([requireAuth()])]) {
				expect(await send(route, configured(), headers)).toEqual({
					status: 401,
					challenge,
					body: failedBody,
					calls,
				});
			}
		});
	}

	it("challenges every allowed scheme, in priority order, when a protected route gets none", async () => {
		const declared = await send(whoami([requireAuth()]), configured(), {});
		const prioritized = await send(
			whoami([requireAuth()]),
			configured({ priority: ["session", "userToken", "serviceKey"] }),
			{},
		);

		expect([declared.status, declared.challenge, declared.body?.type]).toEqual([
			401,
			"Bearer, ApiKey, Session",
			"https://routa-ts.dev/problems/authentication-required",
		]);
		expect(prioritized.challenge).toBe("Session, Bearer, ApiKey");
	});

	it("uses static realm overrides and never adds error details to ApiKey or Session", async () => {
		const reject = () => ({ type: "rejected" }) as const;
		const app = createHonoApp([whoami([requireAuth()])], {
			authentication: {
				principal: Principal,
				schemes: {
					serviceKey: apiKey({
						header: "x-api-key",
						challenge: { realm: "partners" },
						authenticate: reject,
					}),
					session: sessionCookie({
						cookie: "sid",
						challenge: { realm: "web" },
						authenticate: reject,
					}),
				},
			},
		});
		const challenge = async (headers: HeadersInit) =>
			(await app.request("/whoami", { headers })).headers.get("www-authenticate");

		expect(await challenge({})).toBe('ApiKey realm="partners", Session realm="web"');
		expect(await challenge({ "x-api-key": "wrong" })).toBe('ApiKey realm="partners"');
		expect(await challenge({ cookie: "sid=wrong" })).toBe('Session realm="web"');
	});
});

describe("credential selection", () => {
	it("selects the first presented scheme by priority and runs only its authenticator", async () => {
		const all = { ...credentials.bearer, ...credentials.apiKey, ...credentials.session };

		expect((await send(whoami(), configured(), all)).body.auth.scheme).toBe("userToken");
		expect((await send(whoami(), configured(), all)).calls).toEqual(["userToken"]);

		const prioritized = configured({ priority: ["session", "serviceKey", "userToken"] });
		const result = await send(whoami(), prioritized, all);
		expect([result.body.auth.scheme, result.calls]).toEqual(["session", ["session"]]);
	});

	it("never falls back after the selected credential is rejected or malformed", async () => {
		for (const authorization of ["Bearer expired", "Bearer not a token"]) {
			const result = await send(whoami(), configured(), {
				authorization,
				...credentials.session,
			});

			expect([result.status, result.challenge, result.body]).toEqual([
				401,
				'Bearer error="invalid_token"',
				failedBody,
			]);
			expect(result.calls).not.toContain("session");
		}
	});

	it("never lets a credential of a disallowed scheme satisfy a restricted requireAuth", async () => {
		const sessionOnly = whoami([requireAuth({ schemes: ["session"] as never })]);
		const result = await send(sessionOnly, configured(), credentials.bearer);

		expect(result).toEqual({ status: 401, challenge: "Session", body: failedBody, calls: [] });
	});

	it("selects only among allowed schemes, ignoring higher-priority disallowed credentials", async () => {
		const sessionOnly = whoami([requireAuth({ schemes: ["session"] as never })]);
		const result = await send(sessionOnly, configured({ strict: true }), {
			...credentials.bearer,
			...credentials.session,
		});

		expect([result.status, result.body.auth.scheme, result.calls]).toEqual([
			200,
			"session",
			["session"],
		]);
	});

	it("intersects every requireAuth guard in the chain before selection and challenges", async () => {
		const route = whoami([
			requireAuth({ schemes: ["userToken", "session"] as never }),
			requireAuth({ schemes: ["session", "serviceKey"] as never }),
		]);

		expect((await send(route, configured(), {})).challenge).toBe("Session");
		expect((await send(route, configured(), credentials.bearer)).status).toBe(401);
		expect((await send(route, configured(), credentials.session)).status).toBe(200);
		expect(() =>
			createHonoApp(
				[
					whoami([
						requireAuth({ schemes: ["userToken"] as never }),
						requireAuth({ schemes: ["session"] as never }),
					]),
				],
				{ authentication: configured().authentication },
			),
		).toThrow("requireAuth() guards on GET /whoami allow no scheme in common.");
	});

	it("fails an Authorization scheme no configured scheme reads, challenging the allowed schemes", async () => {
		const reject = () => ({ type: "rejected" }) as const;
		const keyOnly = {
			principal: Principal,
			schemes: { serviceKey: apiKey({ header: "x-api-key", authenticate: reject }) },
		};

		for (const authorization of ["Basic dXNlcjpwYXNz", "Bearer user-token"]) {
			const response = await createHonoApp([whoami()], { authentication: keyOnly }).request(
				"/whoami",
				{ headers: { authorization } },
			);

			expect([response.status, response.headers.get("www-authenticate")]).toEqual([401, "ApiKey"]);
		}

		const basic = await send(whoami(), configured(), { authorization: "Basic dXNlcjpwYXNz" });
		expect([basic.status, basic.challenge, basic.calls]).toEqual([
			401,
			"Bearer, ApiKey, Session",
			[],
		]);
	});

	it("ignores an unsupported Authorization scheme beside an allowed credential", async () => {
		const result = await send(whoami(), configured(), {
			authorization: "Basic dXNlcjpwYXNz",
			...credentials.apiKey,
		});

		expect([result.status, result.body.auth.scheme, result.calls]).toEqual([
			200,
			"serviceKey",
			["serviceKey"],
		]);
	});
});

describe("strict multiple-credential mode", () => {
	it("returns ambiguousCredentials before any authenticator runs", async () => {
		for (const headers of [
			{ ...credentials.bearer, ...credentials.apiKey },
			{ authorization: "Bearer not a token", ...credentials.session },
			{ "x-api-key": "", ...credentials.session },
		]) {
			for (const route of [whoami(), whoami([requireAuth()])]) {
				expect(await send(route, configured({ strict: true }), headers)).toEqual({
					status: 400,
					challenge: null,
					body: ambiguousBody,
					calls: [],
				});
			}
		}
	});

	it("still authenticates a single credential", async () => {
		const result = await send(whoami(), configured({ strict: true }), credentials.apiKey);

		expect([result.status, result.body.auth.scheme]).toEqual([200, "serviceKey"]);
	});

	it("answers an explicit HEAD operation without a body", async () => {
		const result = await send(headRoute, configured({ strict: true }), {
			...credentials.bearer,
			...credentials.session,
		});

		expect(result).toEqual({ status: 400, challenge: null, body: undefined, calls: [] });
	});

	it("reserves the ambiguousCredentials outcome name where it applies", () => {
		const route = (middleware: readonly unknown[]): HonoRoute => ({
			...whoami(middleware),
			contract: createRoute({
				middleware: middleware as never,
				responses: { ok: { status: 200 }, ambiguousCredentials: { status: 400 } },
				run: () => ({ type: "ok" }),
			}),
		});
		const strict = configured({ strict: true }).authentication;

		expect(() => createHonoApp([route([])], { authentication: strict })).toThrow(
			'Outcome "ambiguousCredentials" on GET /whoami is declared by the route and by Routa authentication.',
		);
		expect(() =>
			createHonoApp([route([requireAuth({ schemes: ["session"] as never })])], {
				authentication: strict,
			}),
		).not.toThrow();
		expect(() =>
			createHonoApp([route([])], { authentication: configured().authentication }),
		).not.toThrow();
	});
});

describe("credential values stay out of logs", () => {
	it("logs neither API keys nor session values, even when an authenticator throws", async () => {
		const events: RoutaLogEvent[] = [];
		const logger = createLogger({ sink: (event) => events.push(event) });
		const app = createHonoApp([whoami()], {
			logger,
			authentication: {
				principal: Principal,
				schemes: {
					serviceKey: apiKey({
						header: "x-api-key",
						authenticate: (key) => {
							throw new Error(`provider rejected ${key}`);
						},
					}),
					session: sessionCookie({ cookie: "session", authenticate: () => ({ type: "rejected" }) }),
				},
			},
		});

		expect(
			(await app.request("/whoami?x=1", { headers: { "x-api-key": "key-secret-value" } })).status,
		).toBe(500);
		expect(
			(await app.request("/whoami", { headers: { cookie: "session=session-secret-value" } }))
				.status,
		).toBe(401);
		const logged = JSON.stringify(events);
		expect(logged).toContain("http.request");
		expect(logged).toContain("http.error");
		expect(logged).not.toContain("key-secret-value");
		expect(logged).not.toContain("session-secret-value");
	});
});

describe("credential scheme configuration", () => {
	const reject = () => ({ type: "rejected" }) as const;
	const key = (header: string) => apiKey({ header, authenticate: reject });
	const cookie = (name: string) => sessionCookie({ cookie: name, authenticate: reject });

	it("rejects overlapping transports", () => {
		const cases: Array<[Record<string, unknown>, string]> = [
			[
				{ a: key("X-Api-Key"), b: key("x-api-key") },
				'schemes "a" and "b" both read the x-api-key header.',
			],
			[
				{ a: cookie("session"), b: cookie("session") },
				'schemes "a" and "b" both read the "session" cookie.',
			],
			[
				{ a: key("Authorization") },
				'scheme "a" reads the Authorization header, which carries Authorization-scheme credentials such as Bearer. Use bearer() for Bearer tokens.',
			],
			[
				{ a: key("cookie") },
				'scheme "a" reads the Cookie header, which carries cookies. Use sessionCookie() for a session cookie.',
			],
		];

		for (const [schemes, message] of cases) {
			expect(() =>
				createHonoApp([whoami()], { authentication: { principal: Principal, schemes } as never }),
			).toThrow(message);
		}
	});

	it("validates priority and multipleCredentials", () => {
		const schemes = { a: key("x-a"), b: cookie("b") };
		const cases: Array<[Record<string, unknown>, string]> = [
			[{ priority: ["a", "c"] }, 'priority lists "c", which schemes does not declare.'],
			[{ priority: ["a", "b", "a"] }, 'priority lists "a" more than once.'],
			[{ priority: ["b"] }, 'priority omits "a". List every scheme exactly once.'],
			[{ priority: "a" }, "priority must be a list of scheme names."],
			[{ multipleCredentials: "first" }, 'multipleCredentials must be "priority" or "reject".'],
		];

		for (const [options, message] of cases) {
			expect(() =>
				createHonoApp([whoami()], {
					authentication: { principal: Principal, schemes, ...options } as never,
				}),
			).toThrow(message);
		}
	});

	it("validates header names, cookie names, and challenge overrides", () => {
		expect(() => key("x api key")).toThrow(
			'apiKey() header must be an HTTP header name, such as "x-api-key".',
		);
		expect(() => key("")).toThrow(
			'apiKey() header must be an HTTP header name, such as "x-api-key".',
		);
		expect(() => cookie("se;ssion")).toThrow(
			'sessionCookie() cookie must be a cookie name, such as "session".',
		);
		expect(() =>
			apiKey({ header: "x-api-key", challenge: { realm: "" }, authenticate: reject }),
		).toThrow(
			'apiKey() challenge realm must be a non-empty string of printable ASCII without " or \\.',
		);
		expect(() =>
			sessionCookie({ cookie: "sid", challenge: { scope: "x" } as never, authenticate: reject }),
		).toThrow(
			'sessionCookie() challenge declares "scope". A Session challenge override accepts only realm.',
		);
		expect(() => apiKey({ header: "x-api-key" } as never)).toThrow(
			"apiKey() needs an authenticate function.",
		);
		expect(() =>
			createHonoApp([whoami()], {
				authentication: {
					principal: Principal,
					schemes: { a: { kind: "apiKey", header: "bad header", authenticate: reject } },
				} as never,
			}),
		).toThrow('scheme "a" header must be an HTTP header name, such as "x-api-key".');
	});
});

/** Type fixtures: compiled, never run. */
function typesOnly(_check: () => void): void {}

describe("credential scheme configuration (types)", () => {
	it("shares one authenticator contract and checks priority names", () => {
		typesOnly(() => {
			createRouta({
				authentication: {
					principal: Principal,
					schemes: {
						serviceKey: apiKey({
							header: "x-api-key",
							authenticate: async (key, { logger }) => {
								logger.debug("auth.key", "Checking a key.");
								return key === "k"
									? { type: "authenticated", principal: { type: "service", id: "svc" } }
									: { type: "rejected" };
							},
						}),
						session: sessionCookie({
							cookie: "session",
							authenticate: () => ({ type: "rejected" }),
						}),
					},
					priority: ["session", "serviceKey"],
					multipleCredentials: "reject",
				},
			});

			createRouta({
				authentication: {
					principal: Principal,
					schemes: {
						// @ts-expect-error "admin" is not a principal type the schema accepts.
						session: sessionCookie({
							cookie: "session",
							authenticate: () => ({
								type: "authenticated",
								principal: { type: "admin", id: "a" },
							}),
						}),
					},
				},
			});

			createRouta({
				authentication: {
					principal: Principal,
					schemes: {
						session: sessionCookie({
							cookie: "session",
							authenticate: () => ({ type: "rejected" }),
						}),
					},
					// @ts-expect-error priority lists only configured scheme names.
					priority: ["userToken"],
				},
			});

			createRouta({
				authentication: {
					principal: Principal,
					schemes: {
						session: sessionCookie({
							cookie: "session",
							authenticate: () => ({ type: "rejected" }),
						}),
					},
					// @ts-expect-error multipleCredentials is "priority" or "reject".
					multipleCredentials: "first",
				},
			});

			// @ts-expect-error An API-key scheme needs a header name.
			apiKey({ authenticate: () => ({ type: "rejected" }) });
		});
	});
});
