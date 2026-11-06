import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import {
	createApplication,
	createHonoApp,
	createProjectApplication,
	type HonoRoute,
} from "./hono.js";
import {
	bearer,
	createMiddleware,
	createRoute,
	createRouta,
	defineServices,
	requireAuth,
} from "./index.js";
import { createLogger, type RoutaLogEvent } from "./logger.js";
import { createTestApplication } from "./testing.js";

const Principal = z.discriminatedUnion("type", [
	z.object({ type: z.literal("user"), id: z.string(), email: z.string() }),
	z.object({ type: z.literal("service"), id: z.string() }),
]);

const userToken = bearer({
	authenticate: (token) =>
		token === "valid-user"
			? { type: "authenticated", principal: { type: "user", id: "user_1", email: "a@example.com" } }
			: { type: "rejected" },
});

const authentication = { principal: Principal, schemes: { userToken } };

const whoami: HonoRoute = {
	method: "get",
	path: "/whoami",
	contract: createRoute({
		responses: { ok: { status: 200, schema: z.object({ auth: z.unknown() }) } },
		run: ({ ctx }) => ({ type: "ok", data: { auth: (ctx as { auth?: unknown }).auth } }),
	}),
};

describe("Bearer authentication on a public route", () => {
	it("gives anonymous context without a credential and authenticated context with a valid one", async () => {
		const app = createHonoApp([whoami], { authentication });

		const anonymous = await app.request("/whoami");
		expect(anonymous.status).toBe(200);
		expect(await anonymous.json()).toEqual({ auth: { status: "anonymous" } });

		const authenticated = await app.request("/whoami", {
			headers: { authorization: "Bearer valid-user" },
		});
		expect(authenticated.status).toBe(200);
		expect(await authenticated.json()).toEqual({
			auth: {
				status: "authenticated",
				scheme: "userToken",
				principal: { type: "user", id: "user_1", email: "a@example.com" },
			},
		});
	});
});

const protectedRoute: HonoRoute = {
	method: "post",
	path: "/projects",
	contract: createRoute({
		input: { body: z.object({ name: z.string() }) },
		middleware: [requireAuth()],
		responses: { created: { status: 201, schema: z.object({ owner: z.string() }) } },
		run: ({ ctx }) => {
			const auth = (ctx as unknown as { auth: { status: string; principal?: { id: string } } })
				.auth;
			return { type: "created", data: { owner: `${auth.status}:${auth.principal?.id}` } };
		},
	}),
};

const requiredBody = {
	type: "https://routa-ts.dev/problems/authentication-required",
	title: "Authentication required",
	status: 401,
};

const failedBody = {
	type: "https://routa-ts.dev/problems/authentication-failed",
	title: "Authentication failed",
	status: 401,
};

describe("requireAuth", () => {
	it("returns authenticationRequired with a Bearer challenge for an anonymous request", async () => {
		const app = createHonoApp([protectedRoute], { authentication });

		const response = await app.request("/projects", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: "Atlas" }),
		});

		expect(response.status).toBe(401);
		expect(response.headers.get("www-authenticate")).toBe("Bearer");
		expect(await response.json()).toEqual(requiredBody);
	});

	it("lets an authenticated request reach the handler with authenticated context", async () => {
		const app = createHonoApp([protectedRoute], { authentication });

		const response = await app.request("/projects", {
			method: "POST",
			headers: { "content-type": "application/json", authorization: "Bearer valid-user" },
			body: JSON.stringify({ name: "Atlas" }),
		});

		expect(response.status).toBe(201);
		expect(await response.json()).toEqual({ owner: "authenticated:user_1" });
	});

	it("challenges with the configured realm and no error details", async () => {
		const app = createHonoApp([protectedRoute], {
			authentication: {
				principal: Principal,
				schemes: {
					userToken: bearer({
						challenge: { realm: "api" },
						authenticate: () => ({ type: "rejected" }),
					}),
				},
			},
		});

		const response = await app.request("/projects", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: "Atlas" }),
		});

		expect(response.status).toBe(401);
		expect(response.headers.get("www-authenticate")).toBe('Bearer realm="api"');
	});

	it("guards an explicit HEAD operation with bodyless authentication outcomes", async () => {
		const app = createHonoApp(
			[
				{
					method: "head",
					path: "/files",
					contract: createRoute({
						middleware: [requireAuth()],
						responses: { ok: { status: 200 } },
						run: () => ({ type: "ok" }),
					}),
				},
			],
			{ authentication },
		);

		const anonymous = await app.request("/files", { method: "HEAD" });
		const rejected = await app.request("/files", {
			method: "HEAD",
			headers: { authorization: "Bearer wrong" },
		});
		const accepted = await app.request("/files", {
			method: "HEAD",
			headers: { authorization: "Bearer valid-user" },
		});

		expect([anonymous.status, anonymous.headers.get("www-authenticate")]).toEqual([401, "Bearer"]);
		expect(await anonymous.text()).toBe("");
		expect([rejected.status, rejected.headers.get("www-authenticate")]).toEqual([
			401,
			'Bearer error="invalid_token"',
		]);
		expect(await rejected.text()).toBe("");
		expect(accepted.status).toBe(200);
	});
});

describe("presented credentials fail closed", () => {
	const cases = [
		["a rejected token", "Bearer expired-token", 'Bearer error="invalid_token"', 1],
		["a malformed token", "Bearer not a token", 'Bearer error="invalid_token"', 0],
		["an empty Bearer credential", "Bearer", 'Bearer error="invalid_token"', 0],
		["another authentication scheme", "Basic dXNlcjpwYXNz", "Bearer", 0],
		["a tab after Bearer, which RFC 9110 does not allow", "Bearer\tvalid-user", "Bearer", 0],
	] as const;

	for (const [label, header, challenge, expectedCalls] of cases) {
		it(`returns authenticationFailed for ${label} on public and protected routes`, async () => {
			let calls = 0;
			const counted = bearer({
				authenticate: (token, context) => {
					calls += 1;
					return userToken.authenticate(token, context);
				},
			});
			const app = createHonoApp([whoami, protectedRoute], {
				authentication: { principal: Principal, schemes: { userToken: counted } },
			});

			for (const request of [
				new Request("http://localhost/whoami", { headers: { authorization: header } }),
				new Request("http://localhost/projects", {
					method: "POST",
					headers: { authorization: header, "content-type": "application/json" },
					body: JSON.stringify({ name: "Atlas" }),
				}),
			]) {
				calls = 0;
				const response = await app.request(request);

				expect(response.status).toBe(401);
				expect(response.headers.get("www-authenticate")).toBe(challenge);
				expect(await response.json()).toEqual(failedBody);
				expect(calls).toBe(expectedCalls);
			}
		});
	}

	it("fails before Accept negotiation and input parsing", async () => {
		const app = createHonoApp([protectedRoute], { authentication });

		const response = await app.request("/projects", {
			method: "POST",
			headers: {
				authorization: "Bearer expired-token",
				accept: "text/html",
				"content-type": "text/plain",
			},
			body: "not json",
		});

		expect(response.status).toBe(401);
		expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
		expect(await response.json()).toEqual(failedBody);
	});

	it("adds the realm to an invalid_token challenge", async () => {
		const app = createHonoApp([whoami], {
			authentication: {
				principal: Principal,
				schemes: {
					userToken: bearer({
						challenge: { realm: "api" },
						authenticate: () => ({ type: "rejected" }),
					}),
				},
			},
		});

		const response = await app.request("/whoami", { headers: { authorization: "Bearer abc" } });

		expect(response.headers.get("www-authenticate")).toBe(
			'Bearer realm="api", error="invalid_token"',
		);
	});
});

describe("authenticator failures", () => {
	function serveWith(authenticate: Parameters<typeof bearer>[0]["authenticate"]) {
		const events: RoutaLogEvent[] = [];
		const app = createHonoApp([whoami], {
			logger: createLogger({ sink: (event) => events.push(event) }),
			authentication: { principal: Principal, schemes: { userToken: bearer({ authenticate }) } },
		});
		return { app, events };
	}

	it("keeps a thrown authenticator error a server error and logs no provider detail", async () => {
		const { app, events } = serveWith(() => {
			throw new Error("provider said: token secret-token-value is revoked");
		});

		const response = await app.request("/whoami", {
			headers: { authorization: "Bearer secret-token-value" },
		});

		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({
			type: "https://routa-ts.dev/problems/internal",
			title: "Internal Server Error",
			status: 500,
		});
		const logged = JSON.stringify(events);
		expect(logged).toContain('Authenticator for scheme \\"userToken\\" threw.');
		expect(logged).not.toContain("secret-token-value");
		expect(logged).not.toContain("provider said");
	});

	it("logs nothing the thrown error carries, not even its name", async () => {
		const { app, events } = serveWith(() => {
			const error = new Error("hidden");
			error.name = "SecretToken123";
			throw error;
		});

		const response = await app.request("/whoami", {
			headers: { authorization: "Bearer SecretToken123" },
		});

		expect(response.status).toBe(500);
		expect(events.find((event) => event.event === "http.error")?.data).toMatchObject({
			name: "AuthenticatorError",
			scheme: "userToken",
		});
		expect(JSON.stringify(events)).not.toContain("SecretToken123");
	});

	it("reports a principal that fails the principal schema as a contract violation", async () => {
		const { app, events } = serveWith(() => ({
			type: "authenticated",
			principal: { type: "user", id: "user_1" },
		}));

		const response = await app.request("/whoami", { headers: { authorization: "Bearer abc" } });

		expect(response.status).toBe(500);
		const error = events.find((event) => event.event === "http.error");
		expect(error?.data).toMatchObject({
			error:
				'Authenticator for scheme "userToken" returned a principal that does not match the principal schema.',
			name: "AuthenticationContractError",
		});
		expect(JSON.stringify(events)).not.toContain("abc");
	});

	it("keeps an error thrown while parsing the principal a safe server error", async () => {
		const events: RoutaLogEvent[] = [];
		const throwing = z.object({ id: z.string(), type: z.string() }).transform((principal) => ({
			...principal,
			tenant: z.string({ error: "tenant lookup said: secret-tenant-detail" }).parse(42),
		}));
		const app = createHonoApp([whoami], {
			logger: createLogger({ sink: (event) => events.push(event) }),
			authentication: {
				principal: throwing,
				schemes: {
					userToken: bearer({
						authenticate: () => ({ type: "authenticated", principal: { id: "u", type: "user" } }),
					}),
				},
			},
		});

		const response = await app.request("/whoami", { headers: { authorization: "Bearer abc" } });

		expect(response.status).toBe(500);
		expect(await response.text()).not.toContain("secret-tenant-detail");
		expect(events.find((event) => event.event === "http.error")?.data).toMatchObject({
			name: "AuthenticationContractError",
		});
		expect(JSON.stringify(events)).not.toContain("secret-tenant-detail");
	});

	it("keeps a getter that throws on the parsed principal a safe server error", async () => {
		const events: RoutaLogEvent[] = [];
		const getter = z.object({ id: z.string(), type: z.string() }).transform((principal) => ({
			get id(): string {
				return z.string({ error: "provider said: secret-getter-detail" }).parse(42);
			},
			type: principal.type,
		}));
		const app = createHonoApp([whoami], {
			logger: createLogger({ sink: (event) => events.push(event) }),
			authentication: {
				principal: getter as never,
				schemes: {
					userToken: bearer({
						authenticate: () => ({ type: "authenticated", principal: { id: "u", type: "user" } }),
					}),
				},
			},
		});

		const response = await app.request("/whoami", { headers: { authorization: "Bearer abc" } });

		expect(response.status).toBe(500);
		expect(await response.text()).not.toContain("secret-getter-detail");
		expect(events.find((event) => event.event === "http.error")?.data).toMatchObject({
			name: "AuthenticationContractError",
		});
		expect(JSON.stringify(events)).not.toContain("secret-getter-detail");
	});

	it("reports a result that is neither authenticated nor rejected as a contract violation", async () => {
		const { app, events } = serveWith(() => null as never);

		const response = await app.request("/whoami", { headers: { authorization: "Bearer abc" } });

		expect(response.status).toBe(500);
		expect(events.find((event) => event.event === "http.error")?.data).toMatchObject({
			name: "AuthenticationContractError",
		});
	});

	it("keeps an error thrown while reading the result type a safe server error", async () => {
		const { app, events } = serveWith(
			() =>
				({
					get type() {
						return z.string({ error: "provider said: secret-token-value" }).parse(42);
					},
				}) as never,
		);

		const response = await app.request("/whoami", {
			headers: { authorization: "Bearer secret-token-value" },
		});

		expect(response.status).toBe(500);
		expect(await response.text()).not.toContain("provider said");
		expect(events.find((event) => event.event === "http.error")?.data).toMatchObject({
			name: "AuthenticationContractError",
		});
		expect(JSON.stringify(events)).not.toContain("secret-token-value");
	});

	it("reports a principal schema output without string id and type as a contract violation", async () => {
		const events: RoutaLogEvent[] = [];
		const app = createHonoApp([whoami], {
			logger: createLogger({ sink: (event) => events.push(event) }),
			authentication: {
				principal: z.any(),
				schemes: {
					userToken: bearer({
						authenticate: () => ({ type: "authenticated", principal: { name: "Ada" } }),
					}),
				},
			},
		});

		const response = await app.request("/whoami", { headers: { authorization: "Bearer abc" } });

		expect(response.status).toBe(500);
		expect(events.find((event) => event.event === "http.error")?.data).toMatchObject({
			error:
				'The principal schema parsed the principal from scheme "userToken" to a value without string id and type fields.',
			name: "AuthenticationContractError",
		});
	});
});

describe("principal and authenticator context", () => {
	it("parses the principal once and gives handlers the schema output", async () => {
		let parses = 0;
		const app = createHonoApp([whoami], {
			authentication: {
				principal: z.object({ id: z.string(), type: z.literal("user") }).transform((value) => {
					parses += 1;
					return { ...value, label: `user:${value.id}` };
				}),
				schemes: {
					userToken: bearer({
						authenticate: () => ({ type: "authenticated", principal: { id: "u1", type: "user" } }),
					}),
				},
			},
		});

		const response = await app.request("/whoami", { headers: { authorization: "Bearer abc" } });

		expect(await response.json()).toEqual({
			auth: {
				status: "authenticated",
				scheme: "userToken",
				principal: { id: "u1", type: "user", label: "user:u1" },
			},
		});
		expect(parses).toBe(1);
	});

	it("gives the authenticator the token, application services, and logger", async () => {
		const seen: unknown[] = [];
		const app = await createApplication([whoami], {
			services: {
				factory: defineServices<{ users: { find(token: string): string | undefined } }>()(() => ({
					users: { find: (token) => (token === "abc" ? "user_9" : undefined) },
				})),
				names: ["users"],
			},
			authentication: {
				principal: Principal,
				schemes: {
					userToken: bearer({
						authenticate: (token, context) => {
							seen.push(token, Object.keys(context).sort());
							const id = (
								context as unknown as {
									services: { users: { find(token: string): string | undefined } };
								}
							).services.users.find(token);
							return id
								? { type: "authenticated", principal: { type: "service", id } }
								: { type: "rejected" };
						},
					}),
				},
			},
		});

		const response = await app.fetch(
			new Request("http://localhost/whoami", { headers: { authorization: "Bearer abc" } }),
		);

		expect(await response.json()).toEqual({
			auth: {
				status: "authenticated",
				scheme: "userToken",
				principal: { type: "service", id: "user_9" },
			},
		});
		expect(seen).toEqual(["abc", ["logger", "services"]]);
		await app.dispose();
	});

	it("keeps ctx.auth readonly for middleware and handlers", async () => {
		const overwrite = createMiddleware({
			run: ({ ctx, next }) => {
				(ctx as Record<string, unknown>).auth = { status: "authenticated" };
				return next();
			},
		});
		const app = createHonoApp(
			[{ ...whoami, contract: { ...whoami.contract, middleware: [overwrite] } }],
			{ authentication },
		);

		const response = await app.request("/whoami");

		expect(response.status).toBe(500);
	});
});

describe("authentication registration", () => {
	it("rejects requireAuth without authentication", () => {
		expect(() => createHonoApp([protectedRoute])).toThrow(
			"requireAuth() on POST /projects needs authentication. Configure authentication in createRouta.",
		);
	});

	it("rejects requireAuth that allows an undeclared scheme", () => {
		const route: HonoRoute = {
			...protectedRoute,
			contract: {
				...protectedRoute.contract,
				middleware: [requireAuth({ schemes: ["serviceKey" as never] })],
			},
		};

		expect(() => createHonoApp([route], { authentication })).toThrow(
			'requireAuth() on POST /projects allows scheme "serviceKey", which createRouta authentication does not declare.',
		);
	});

	it("reserves ctx.auth and the authentication outcome names", () => {
		const providesAuth = createMiddleware({
			provides: { auth: z.string() },
			run: ({ next }) => next({ auth: "x" }),
		});

		expect(() =>
			createHonoApp([{ ...whoami, contract: { ...whoami.contract, middleware: [providesAuth] } }], {
				authentication,
			}),
		).toThrow(
			"middleware[0] on GET /whoami provides ctx.auth, which Routa reserves for authentication.",
		);
		expect(() =>
			createHonoApp(
				[
					{
						...whoami,
						contract: { ...whoami.contract, responses: { authenticationFailed: { status: 401 } } },
					},
				],
				{ authentication },
			),
		).toThrow(
			'Outcome "authenticationFailed" on GET /whoami is declared by the route and by Routa authentication.',
		);
		expect(() =>
			createHonoApp([{ ...whoami, contract: { ...whoami.contract, middleware: [providesAuth] } }]),
		).not.toThrow();
	});

	it("shares one authenticationRequired outcome between route and method guards", async () => {
		const route: HonoRoute = {
			...protectedRoute,
			contract: {
				...protectedRoute.contract,
				middleware: [requireAuth(), requireAuth({ schemes: ["userToken"] as never })],
			},
		};
		const app = createHonoApp([route], { authentication });

		const response = await app.request("/projects", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: "Atlas" }),
		});

		expect(response.status).toBe(401);
	});

	it("validates the authentication configuration", () => {
		const reject = () => ({ type: "rejected" }) as const;
		const cases: Array<[unknown, string]> = [
			[
				{ schemes: { userToken: bearer({ authenticate: reject }) } },
				"principal must be a Zod schema.",
			],
			[{ principal: Principal, schemes: {} }, "declares no credential schemes."],
			[
				{ principal: Principal, schemes: { "2": bearer({ authenticate: reject }) } },
				'scheme name "2" must start with a letter and use only letters, digits, ".", "-", and "_".',
			],
			[
				{ principal: Principal, schemes: { "user token": bearer({ authenticate: reject }) } },
				'scheme name "user token" must start with a letter and use only letters, digits, ".", "-", and "_".',
			],
			[
				{ principal: Principal, schemes: { userToken: { kind: "basic" } } },
				'scheme "userToken" must be declared with bearer(), apiKey(), or sessionCookie().',
			],
			[
				{
					principal: Principal,
					schemes: {
						userToken: bearer({ authenticate: reject }),
						adminToken: bearer({ authenticate: reject }),
					},
				},
				'schemes "userToken" and "adminToken" both read the Authorization Bearer credential.',
			],
		];

		for (const [config, message] of cases) {
			expect(() => createHonoApp([whoami], { authentication: config as never })).toThrow(message);
		}
	});

	it("validates Bearer challenge overrides", () => {
		const reject = () => ({ type: "rejected" }) as const;

		expect(() => bearer({ challenge: { realm: 'a"b' }, authenticate: reject })).toThrow(
			'bearer() challenge realm must be a non-empty string of printable ASCII without " or \\.',
		);
		expect(() => bearer({ challenge: { scope: "read" } as never, authenticate: reject })).toThrow(
			'bearer() challenge declares "scope". A Bearer challenge override accepts only realm.',
		);
		expect(() => requireAuth({ schemes: [] as never })).toThrow(
			"requireAuth() schemes must be a non-empty list of scheme names.",
		);
	});
});

describe("project applications", () => {
	function project(
		overrides: { config?: Record<string, unknown>; metadata?: Record<string, unknown> } = {},
	) {
		return {
			".routa/routes.gen.ts": () =>
				Promise.resolve({
					routaAuthenticationSchemes: ["userToken"],
					routaMultipleCredentials: "priority",
					routaRoutes: [
						{
							file: "src/routes/projects/route.ts",
							path: "/projects",
							methods: ["POST"],
							middlewareFiles: [],
						},
					],
					...overrides.metadata,
				}),
			"src/routa.ts": () =>
				Promise.resolve({ default: { logger: false, authentication, ...overrides.config } }),
			"src/routes/projects/route.ts": () =>
				Promise.resolve({ default: { post: protectedRoute.contract } }),
		};
	}

	it("authenticates requests to a test application", async () => {
		const app = await createTestApplication(project());
		const post = (headers: Record<string, string>) =>
			app.request("/projects", {
				method: "POST",
				headers: { "content-type": "application/json", ...headers },
				body: JSON.stringify({ name: "Atlas" }),
			});

		expect((await post({})).status).toBe(401);
		expect(await (await post({ authorization: "Bearer valid-user" })).json()).toEqual({
			owner: "authenticated:user_1",
		});
		await app.dispose();
	});

	it("reports where the project and its generated metadata disagree", async () => {
		const cases: Array<[Parameters<typeof project>[0], string]> = [
			[
				{ config: { authentication: undefined } },
				".routa/routes.gen.ts declares authentication schemes, but src/routa.ts configures no authentication. Run routa generate.",
			],
			[
				{ metadata: { routaAuthenticationSchemes: undefined } },
				"src/routa.ts configures authentication that routa generate could not read from source. Write authentication as a literal in the createRouta object, then run routa generate.",
			],
			[
				{ metadata: { routaAuthenticationSchemes: ["adminToken"] } },
				'src/routa.ts configures authentication schemes "userToken", but .routa/routes.gen.ts declares "adminToken". Run routa generate.',
			],
			[
				{ config: { authentication: { ...authentication, multipleCredentials: "reject" } } },
				'src/routa.ts configures multipleCredentials "reject", but .routa/routes.gen.ts declares "priority". Run routa generate.',
			],
		];

		for (const [overrides, message] of cases) {
			await expect(createTestApplication(project(overrides))).rejects.toThrow(message);
		}
	});

	/** A public route below a folder `middleware.ts` that exports `exports`, of which the metadata lists `listed`. */
	function folderProject(exports: Record<string, unknown>, listed: readonly string[] = []) {
		const folder = "src/routes/middleware.ts";
		const modules: Record<string, () => Promise<unknown>> = {
			...project({
				metadata: {
					routaRoutes: [
						{
							file: "src/routes/projects/route.ts",
							path: "/projects",
							methods: ["GET"],
							middleware: listed.map((name) => ({ file: folder, name })),
							middlewareFiles: [folder],
						},
					],
				},
			}),
			[folder]: () => Promise.resolve(exports),
			"src/routes/projects/route.ts": () => Promise.resolve({ default: { get: whoami.contract } }),
		};
		return { modules, load: (file: string) => modules[file]!() };
	}

	it("refuses to start when a folder guard is missing from the generated metadata", async () => {
		// A guard routa generate could not read, such as one a factory builds, is never listed.
		const guardFor = () => requireAuth();
		const { modules, load } = folderProject({
			signedIn: guardFor(),
			withNothing: createMiddleware({ run: ({ next }) => next() }),
		});
		const message =
			"src/routes/middleware.ts exports signedIn, a requireAuth() guard .routa/routes.gen.ts does not list, so it would not run and the routes below would be public. Write it as export const signedIn = requireAuth({ ... }), or re-export a const declared that way, then run routa generate.";

		await expect(createTestApplication(modules)).rejects.toThrow(message);
		await expect(createProjectApplication(load, { runtimeMode: "start" })).rejects.toThrow(message);
	});

	it("runs a folder guard the generated metadata lists", async () => {
		const { modules, load } = folderProject({ signedIn: requireAuth() }, ["signedIn"]);
		const app = await createTestApplication(modules);
		const { application } = await createProjectApplication(load, { runtimeMode: "start" });
		const signedIn = {
			auth: {
				status: "authenticated",
				scheme: "userToken",
				principal: { type: "user", id: "user_1", email: "a@example.com" },
			},
		};

		try {
			expect((await app.request("/projects")).status).toBe(401);
			expect(
				await (
					await app.request("/projects", { headers: { authorization: "Bearer valid-user" } })
				).json(),
			).toEqual(signedIn);
			expect((await application.fetch(new Request("http://localhost/projects"))).status).toBe(401);
		} finally {
			await app.dispose();
			await application.dispose();
		}
	});

	it("asks to regenerate metadata that lists no folder middleware files", async () => {
		await expect(
			createTestApplication(
				project({
					metadata: {
						routaRoutes: [
							{ file: "src/routes/projects/route.ts", path: "/projects", methods: ["POST"] },
						],
					},
				}),
			),
		).rejects.toThrow(
			".routa/routes.gen.ts lists no folder middleware files for src/routes/projects/route.ts, so Routa cannot check them for requireAuth() guards. Run routa generate.",
		);
	});
});

/** Type fixtures: compiled, never run. */
function typesOnly(_check: () => void): void {}

describe("authentication configuration (types)", () => {
	it("checks each scheme's principal against the principal schema input", () => {
		typesOnly(() => {
			createRouta({
				authentication: {
					principal: Principal,
					schemes: {
						userToken: bearer({
							authenticate: (token) =>
								token === "t"
									? { type: "authenticated", principal: { type: "service", id: token } }
									: { type: "rejected" },
						}),
					},
				},
			});

			createRouta({
				authentication: {
					principal: Principal,
					schemes: {
						// @ts-expect-error "admin" is not a principal type the schema accepts.
						userToken: bearer({
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
						// @ts-expect-error A user principal needs an email.
						userToken: bearer({
							authenticate: async () => ({
								type: "authenticated",
								principal: { type: "user", id: "u" },
							}),
						}),
					},
				},
			});

			createRouta({
				authentication: {
					principal: Principal,
					schemes: {
						// @ts-expect-error A rejection carries no reason.
						userToken: bearer({ authenticate: () => ({ type: "rejected", reason: "expired" }) }),
					},
				},
			});

			createRouta({
				authentication: {
					principal: Principal,
					schemes: {
						// @ts-expect-error A declared union cannot hide a detailed rejection beside a plain one.
						userToken: bearer({
							authenticate: (): { type: "rejected" } | { type: "rejected"; reason: string } => ({
								type: "rejected",
							}),
						}),
					},
				},
			});

			createRouta({
				authentication: {
					principal: Principal,
					schemes: {
						// @ts-expect-error A rejection carries no principal.
						userToken: bearer({
							authenticate: () => ({ type: "rejected", principal: "unexpected" }),
						}),
					},
				},
			});

			createRouta({
				authentication: {
					// @ts-expect-error A principal schema's output has string id and type fields.
					principal: z.object({ name: z.string() }),
					schemes: { userToken: bearer({ authenticate: () => ({ type: "rejected" }) }) },
				},
			});

			// @ts-expect-error A Bearer challenge override accepts only realm.
			bearer({ challenge: { scope: "read" }, authenticate: () => ({ type: "rejected" }) });
		});
	});

	it("names requireAuth's outcome so route outcomes cannot reuse it", () => {
		typesOnly(() => {
			createRoute({
				middleware: [requireAuth()],
				responses: {
					// @ts-expect-error authenticationRequired belongs to requireAuth.
					authenticationRequired: { status: 401 },
					ok: { status: 200 },
				},
				run: () => ({ type: "ok" }),
			});

			// @ts-expect-error Without generated authentication, no scheme name is known.
			requireAuth({ schemes: ["userToken"] });
		});
	});
});
