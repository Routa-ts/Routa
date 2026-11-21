import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { z } from "zod";
import { AuthenticationContractError } from "./authentication.js";
import {
	createApplication,
	createHonoApp,
	createProjectApplication,
	type HonoRoute,
	type RequestServicesDeclaration,
} from "./hono.js";
import {
	bearer,
	createMiddleware,
	createRoute,
	createRouta,
	custom,
	type RequestErrorCode,
	type RequestErrorDiagnostic,
	type RequestErrorReporter,
	type RequestErrorStage,
	requireAuth,
} from "./index.js";
import { createLogger, type RoutaLogEvent } from "./logger.js";

function capture(level: "trace" | "fatal" = "trace") {
	const events: RoutaLogEvent[] = [];
	return { events, logger: createLogger({ level, sink: (event) => events.push(event) }) };
}

/** Records every call a reporter receives. */
function recorder() {
	const calls: Array<{ error: unknown; diagnostic: RequestErrorDiagnostic }> = [];
	const onRequestError: RequestErrorReporter = (error, diagnostic) => {
		calls.push({ error, diagnostic });
	};
	return { calls, onRequestError };
}

const principal = z.object({ id: z.string(), type: z.literal("user") });
const json = { "content-type": "application/json" };

function get(path: string, run: () => unknown, extra: Partial<HonoRoute> = {}): HonoRoute {
	return {
		method: "get",
		path,
		contract: createRoute({
			responses: { ok: { status: 200, schema: z.object({ ok: z.boolean() }) } },
			run: run as never,
		}),
		...extra,
	};
}

const scope = (factory: RequestServicesDeclaration["factory"]): RequestServicesDeclaration => ({
	names: ["audit"],
	after: 0,
	factory,
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("request error reporting", () => {
	it("LOG-AC-13 reports a thrown handler error once, with the original error and frozen metadata", async () => {
		const { events, logger } = capture();
		const { calls, onRequestError } = recorder();
		const thrown = new Error("boom with secret detail");
		const app = createHonoApp(
			[
				get("/boom", () => {
					throw thrown;
				}),
			],
			{ logger, onRequestError, correlation: true },
		);
		const baseline = await createHonoApp([
			get("/boom", () => {
				throw thrown;
			}),
		]).request("/boom");

		const response = await app.request("/boom", { headers: { "x-correlation-id": "trace-1" } });
		const requestId = response.headers.get("x-request-id");

		expect(response.status).toBe(500);
		expect(await response.json()).toEqual(await baseline.json());
		expect(calls).toHaveLength(1);
		expect(calls[0]?.error).toBe(thrown);
		expect(calls[0]?.diagnostic).toEqual({
			code: "unexpected_failure",
			stage: "handler",
			requestId,
			correlationId: "trace-1",
			method: "GET",
			route: "/boom",
			status: 500,
		});
		expect(Object.isFrozen(calls[0]?.diagnostic)).toBe(true);
		expect(events.find((event) => event.event === "http.error")?.data).toEqual({
			requestId,
			correlationId: "trace-1",
			method: "GET",
			route: "/boom",
			status: 500,
			code: "unexpected_failure",
			stage: "handler",
		});
		expect(JSON.stringify(events)).not.toContain("secret");
	});

	it("LOG-AC-13 names the stage of each unexpected failure and passes the error that was thrown", async () => {
		const thrown = new Error("secret");
		const fail = () => {
			throw thrown;
		};
		const failing = createMiddleware({ run: fail });
		const refined = z.object({ q: z.string() }).refine(fail as () => boolean);
		const cases: ReadonlyArray<[RequestErrorStage, HonoRoute, RequestInit?]> = [
			[
				"authentication",
				get("/x", () => ({ type: "ok", data: { ok: true } }), {
					contract: createRoute({
						middleware: [requireAuth()],
						responses: { ok: { status: 200 } },
						run: () => ({ type: "ok" }),
					}),
				}),
				{ headers: { authorization: "Bearer token" } },
			],
			["context", get("/x", () => ({ type: "ok", data: { ok: true } }), { createContext: fail })],
			[
				"input",
				{
					method: "get",
					path: "/x",
					contract: createRoute({
						input: { query: refined },
						responses: { ok: { status: 200 } },
						run: () => ({ type: "ok" }),
					}),
				},
			],
			[
				"services",
				get("/x", () => ({ type: "ok", data: { ok: true } }), {
					services: { method: scope(fail) },
				}),
			],
			[
				"middleware",
				{
					method: "get",
					path: "/x",
					contract: createRoute({
						middleware: [failing],
						responses: { ok: { status: 200 } },
						run: () => ({ type: "ok" }),
					}),
				},
			],
			["handler", get("/x", fail)],
		];

		for (const [stage, route, init] of cases) {
			const { calls, onRequestError } = recorder();
			const { events, logger } = capture();
			const app = createHonoApp([route], {
				logger,
				onRequestError,
				authentication: { principal, schemes: { token: bearer({ authenticate: fail }) } },
			});

			const response = await app.request("/x?q=1", init);

			expect(response.status, stage).toBe(500);
			expect(
				calls.map(({ error, diagnostic }) => [error === thrown, diagnostic.code, diagnostic.stage]),
				stage,
			).toEqual([[true, "unexpected_failure", stage]]);
			expect(events.find((event) => event.event === "http.error")?.data?.stage, stage).toBe(stage);
		}
	});

	it("LOG-AC-13 reports framework-detected contract violations with their stage", async () => {
		const provides = createMiddleware({
			provides: { tenant: z.string() },
			run: ({ next }) => next({ tenant: 1 as never }),
		});
		const authentication = {
			principal,
			schemes: { token: bearer({ authenticate: () => ({ type: "unexpected" }) as never }) },
		};
		const cases: ReadonlyArray<[RequestErrorStage, HonoRoute, RequestInit?]> = [
			["response", get("/x", () => ({ type: "ok", data: { ok: "yes" } }))],
			["response", get("/x", () => ({ type: "missing" }))],
			["response", get("/x", () => ({ type: "ok", data: { ok: true, n: 1n } }))],
			[
				"response",
				{
					method: "get",
					path: "/x",
					contract: createRoute({
						responses: { ok: { status: 200, headers: z.object({ "x-count": z.string() }) } },
						run: () => ({ type: "ok", headers: { "x-count": 1 as never } }),
					}),
				},
			],
			["handler", get("/x", () => "not a result")],
			[
				"middleware",
				{
					method: "get",
					path: "/x",
					contract: createRoute({
						middleware: [provides],
						responses: { ok: { status: 200 } },
						run: () => ({ type: "ok" }),
					}),
				},
			],
			[
				"authentication",
				{
					method: "get",
					path: "/x",
					contract: createRoute({
						middleware: [requireAuth()],
						responses: { ok: { status: 200 } },
						run: () => ({ type: "ok" }),
					}),
				},
				{ headers: { authorization: "Bearer token" } },
			],
		];

		for (const [stage, route, init] of cases) {
			const { calls, onRequestError } = recorder();
			const { events, logger } = capture();
			const app = createHonoApp([route], { logger, onRequestError, authentication });

			const response = await app.request("/x", init);

			expect(response.status, stage).toBe(500);
			expect(
				calls.map(({ error, diagnostic }) => [
					error instanceof Error,
					diagnostic.code,
					diagnostic.stage,
				]),
				stage,
			).toEqual([[true, "contract_violation", stage]]);
			expect(events.find((event) => event.event === "http.error")?.data, stage).toMatchObject({
				code: "contract_violation",
				stage,
			});
		}
	});

	it("LOG-AC-13 does not report expected rejections, declared outcomes, or automatic responses", async () => {
		const { calls, onRequestError } = recorder();
		const { events, logger } = capture();
		const gate = createMiddleware({
			input: { query: z.object({ deny: z.string().optional() }) },
			rejects: { unavailable: { status: 500 } },
			run: ({ input, next }) => (input.query.deny ? { type: "unavailable" } : next()),
		});
		const app = createHonoApp(
			[
				{
					method: "post",
					path: "/items",
					contract: createRoute({
						middleware: [gate],
						input: { body: z.object({ name: z.string() }) },
						responses: {
							created: { status: 201 },
							unavailable503: { status: 503, schema: z.object({ retry: z.boolean() }) },
						},
						run: ({ input }) =>
							input.body.name === "down"
								? { type: "unavailable503", data: { retry: true } }
								: { type: "created" },
					}),
				},
				{
					method: "get",
					path: "/private",
					contract: createRoute({
						middleware: [requireAuth()],
						responses: { ok: { status: 200 } },
						run: () => ({ type: "ok" }),
					}),
				},
			],
			{
				logger,
				onRequestError,
				authentication: {
					principal,
					schemes: { token: bearer({ authenticate: () => ({ type: "rejected" }) }) },
				},
			},
		);
		const sent: ReadonlyArray<[string, RequestInit | undefined, number]> = [
			["/items", { method: "POST", headers: json, body: '{"name":"a"}' }, 201],
			["/items", { method: "POST", headers: json, body: '{"name":"down"}' }, 503],
			["/items?deny=1", { method: "POST", headers: json, body: '{"name":"a"}' }, 500],
			["/items", { method: "POST", headers: json, body: "{}" }, 400],
			["/items", { method: "POST", headers: json, body: "{" }, 400],
			["/items", { method: "POST", headers: { "content-type": "text/plain" }, body: "a" }, 415],
			["/items", { method: "POST", headers: { ...json, accept: "text/html" }, body: "{}" }, 406],
			["/private", undefined, 401],
			["/private", { headers: { authorization: "Bearer token" } }, 401],
			["/items", { method: "OPTIONS" }, 204],
			["/items", { method: "DELETE" }, 405],
			["/nowhere", undefined, 404],
		];

		const statuses = [];
		for (const [path, init] of sent) {
			statuses.push((await app.request(path, init)).status);
		}

		expect(statuses).toEqual(sent.map(([, , status]) => status));
		expect(calls).toEqual([]);
		expect(events.filter((event) => event.event === "http.error")).toEqual([]);
	});

	it("LOG-AC-13 passes what authentication code throws while Routa reads its result", async () => {
		const thrown = new Error("secret");
		const fail = () => {
			throw thrown;
		};
		const route = get("/x", () => ({ type: "ok", data: { ok: true } }), {
			contract: createRoute({
				middleware: [requireAuth()],
				responses: { ok: { status: 200 } },
				run: () => ({ type: "ok" }),
			}),
		});
		const authenticated = () => ({ type: "authenticated", principal: { id: "u", type: "user" } });
		const cases: ReadonlyArray<[string, () => unknown, z.ZodType]> = [
			[
				"result type getter",
				() => ({
					get type() {
						return fail();
					},
				}),
				principal,
			],
			["principal refinement", authenticated, principal.refine(fail as () => boolean)],
			[
				"parsed principal getter",
				authenticated,
				principal.transform(() => ({
					type: "user",
					get id(): string {
						return fail();
					},
				})),
			],
		];

		for (const [name, authenticate, schema] of cases) {
			const { calls, onRequestError } = recorder();
			const { events, logger } = capture();
			const app = createHonoApp([route], {
				logger,
				onRequestError,
				authentication: {
					principal: schema as never,
					schemes: { token: bearer({ authenticate: authenticate as never }) },
				},
			});

			const response = await app.request("/x", { headers: { authorization: "Bearer token" } });

			expect(response.status, name).toBe(500);
			expect(await response.json(), name).toMatchObject({ title: "Internal Server Error" });
			expect(
				calls.map(({ error, diagnostic }) => [error === thrown, diagnostic.code, diagnostic.stage]),
				name,
			).toEqual([[true, "unexpected_failure", "authentication"]]);
			expect(events.find((event) => event.event === "http.error")?.data, name).toMatchObject({
				code: "unexpected_failure",
				stage: "authentication",
			});
		}
	});

	it("LOG-AC-13 reports a principal that fails the schema without throwing as Routa's contract violation", async () => {
		const { calls, onRequestError } = recorder();
		const app = createHonoApp(
			[
				get("/x", () => ({ type: "ok", data: { ok: true } }), {
					contract: createRoute({
						middleware: [requireAuth()],
						responses: { ok: { status: 200 } },
						run: () => ({ type: "ok" }),
					}),
				}),
			],
			{
				onRequestError,
				authentication: {
					principal,
					schemes: {
						token: bearer({
							authenticate: () => ({ type: "authenticated", principal: { id: 1, type: "user" } }),
						}) as never,
					},
				},
			},
		);

		const response = await app.request("/x", { headers: { authorization: "Bearer token" } });

		expect(response.status).toBe(500);
		expect(
			calls.map(({ error, diagnostic }) => [
				error instanceof AuthenticationContractError,
				diagnostic.code,
				diagnostic.stage,
			]),
		).toEqual([[true, "contract_violation", "authentication"]]);
	});

	it("LOG-AC-13 reports one failure once, with the error middleware lets escape", async () => {
		const thrown = new Error("handler");
		const replaced = new Error("middleware");
		const rethrow = createMiddleware({
			run: async ({ next }) => {
				try {
					return await next();
				} catch (error) {
					throw error;
				}
			},
		});
		const replace = createMiddleware({
			run: async ({ next }) => {
				try {
					return await next();
				} catch {
					throw replaced;
				}
			},
		});
		const route = (path: string, middleware: Parameters<typeof createRoute>[0]["middleware"]) => ({
			method: "get" as const,
			path,
			contract: createRoute({
				middleware,
				responses: { ok: { status: 200 } },
				run: () => {
					throw thrown;
				},
			}),
		});
		const { calls, onRequestError } = recorder();
		const inner = createHonoApp([route("/kept", [rethrow]), route("/replaced", [replace])], {
			onRequestError,
		});
		const outer = createHonoApp([], { onRequestError });
		outer.route("/", inner);

		expect((await outer.request("/kept")).status).toBe(500);
		expect((await outer.request("/replaced")).status).toBe(500);
		expect(
			calls.map(({ error, diagnostic }) => [error, diagnostic.stage, diagnostic.route]),
		).toEqual([
			[thrown, "handler", "/kept"],
			[replaced, "middleware", "/replaced"],
		]);
	});

	it("LOG-AC-13 passes a services factory's own error, not the error Routa answers with", async () => {
		const thrown = new z.ZodError([]);
		const { calls, onRequestError } = recorder();
		const app = createHonoApp(
			[
				get("/x", () => ({ type: "ok", data: { ok: true } }), {
					services: {
						method: scope(() => {
							throw thrown;
						}),
					},
				}),
			],
			{ onRequestError },
		);

		const response = await app.request("/x");

		expect(response.status).toBe(500);
		expect(calls.map(({ error, diagnostic }) => [error, diagnostic.stage])).toEqual([
			[thrown, "services"],
		]);
	});

	it("LOG-AC-13 passes a credential extractor's own error", async () => {
		const thrown = new Error("could not parse secret");
		const { calls, onRequestError } = recorder();
		const app = createHonoApp(
			[
				{
					method: "get",
					path: "/x",
					contract: createRoute({
						middleware: [requireAuth()],
						responses: { ok: { status: 200 } },
						run: () => ({ type: "ok" }),
					}),
				},
			],
			{
				onRequestError,
				authentication: {
					principal,
					schemes: {
						device: custom({
							transport: { header: "x-device" },
							openapi: { type: "apiKey", in: "header", name: "x-device" },
							extract: (() => {
								throw thrown;
							}) as never,
							authenticate: (() => ({ type: "rejected" })) as never,
						}),
					},
				},
			},
		);

		expect((await app.request("/x", { headers: { "x-device": "d" } })).status).toBe(500);
		expect(calls.map(({ error, diagnostic }) => [error, diagnostic.stage])).toEqual([
			[thrown, "authentication"],
		]);
	});

	it("LOG-AC-13 keeps the response whatever the reporter returns or does to its arguments", async () => {
		const thrown = new Error("boom");
		const routes = [
			get("/boom", () => {
				throw thrown;
			}),
		];
		const baseline = await createHonoApp(routes).request("/boom");
		const expected = { status: baseline.status, body: await baseline.text() };
		const reporters: RequestErrorReporter[] = [
			() => new Response("replaced", { status: 200 }) as never,
			async () => {
				await new Promise(() => {});
			},
			(_error, diagnostic) => {
				(diagnostic as { status: number }).status = 200;
			},
		];

		for (const onRequestError of reporters) {
			const response = await createHonoApp(routes, { onRequestError }).request("/boom");
			expect({ status: response.status, body: await response.text() }).toEqual(expected);
		}
	});
});

describe("request error reporter failures", () => {
	it("LOG-AC-14 contains a throwing or rejecting reporter with one fallback line per application", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);

		try {
			const routes = [
				get("/boom", () => {
					throw new Error("original secret");
				}),
			];
			const baseline = await createHonoApp(routes).request("/boom");
			const expected = { status: baseline.status, body: await baseline.text() };
			const throwing = vi.fn(() => {
				throw new Error("reporter secret");
			});
			const rejecting = vi.fn(async () => {
				throw new Error("reporter secret");
			});

			for (const onRequestError of [throwing, rejecting]) {
				errors.mockClear();
				const app = createHonoApp(routes, { onRequestError });

				for (let attempt = 0; attempt < 3; attempt += 1) {
					const response = await app.request("/boom");
					expect({ status: response.status, body: await response.text() }).toEqual(expected);
				}
				await new Promise((resolve) => setTimeout(resolve, 0));

				expect(onRequestError).toHaveBeenCalledTimes(3);
				expect(errors).toHaveBeenCalledTimes(1);
				const line = JSON.parse(String(errors.mock.calls[0]?.[0]));
				expect(line).toEqual({
					level: "error",
					event: "routa.on_request_error.failed",
					message:
						"The onRequestError callback threw or rejected. Later failures of this callback in this application are not reported.",
					timestamp: expect.any(String),
				});
				expect(JSON.stringify(errors.mock.calls)).not.toContain("secret");
			}

			// Another application reports its own reporter's first failure.
			errors.mockClear();
			await createHonoApp(routes, { onRequestError: throwing }).request("/boom");
			expect(errors).toHaveBeenCalledTimes(1);
			expect(unhandled).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	it("LOG-AC-14 writes the fallback line when the configured logger's sink is the one failing", async () => {
		const errors = vi.spyOn(console, "error").mockImplementation(() => {});
		const sink = vi.fn(() => {
			throw new Error("sink secret");
		});
		const app = createHonoApp(
			[
				get("/boom", () => {
					throw new Error("boom");
				}),
			],
			{
				logger: createLogger({ sink }),
				onRequestError: () => {
					throw new Error("reporter secret");
				},
			},
		);

		expect((await app.request("/boom")).status).toBe(500);
		expect(errors.mock.calls.map((call) => JSON.parse(String(call[0])).event).sort()).toEqual([
			"routa.logger.sink_failed",
			"routa.on_request_error.failed",
		]);
		expect(JSON.stringify(errors.mock.calls)).not.toContain("secret");
	});
});

describe("request error reporter configuration", () => {
	const boom = get("/boom", () => {
		throw new Error("boom");
	});

	it("LOG-AC-14 keeps reporting with logging disabled or above error level", async () => {
		const { calls, onRequestError } = recorder();
		const quiet = capture("fatal");
		const modules: Record<string, unknown> = {
			".routa/routes.gen.ts": {
				routaRoutes: [
					{
						file: "src/routes/boom/route.ts",
						path: "/boom",
						methods: ["GET"],
						middlewareFiles: [],
					},
				],
			},
			"src/routa.ts": { default: createRouta({ logger: false, onRequestError }) },
			"src/routes/boom/route.ts": { default: { get: boom.contract } },
		};
		const project = await createProjectApplication(async (file) => modules[file], {
			runtimeMode: "start",
		});
		const applications = [
			{ fetch: (request: Request) => createHonoApp([boom], { onRequestError }).fetch(request) },
			await createApplication([boom], { onRequestError, logger: quiet.logger }),
			project.application,
		];

		for (const application of applications) {
			const response = await application.fetch(new Request("http://localhost/boom"));
			expect(response.status).toBe(500);
		}

		expect(calls.map(({ diagnostic }) => diagnostic.stage)).toEqual([
			"handler",
			"handler",
			"handler",
		]);
		expect(quiet.events).toEqual([]);
		await project.application.dispose();
	});

	it("LOG-AC-14 rejects a reporter that is not a function at startup", async () => {
		const message =
			"onRequestError must be a function that receives the original error and its diagnostic. Omit it to report nothing.";

		expect(() => createHonoApp([boom], { onRequestError: "report" as never })).toThrow(
			new TypeError(message),
		);
		await expect(createApplication([boom], { onRequestError: {} as never })).rejects.toThrow(
			new TypeError(message),
		);
		await expect(
			createProjectApplication(
				async (file) =>
					({
						".routa/routes.gen.ts": { routaRoutes: [] },
						"src/routa.ts": { default: { onRequestError: null } },
					})[file],
				{ runtimeMode: "start" },
			),
		).rejects.toThrow(new TypeError(message));
	});

	it("LOG-AC-14 leaves startup, cleanup, and Hono handler errors to their owners", async () => {
		const { calls, onRequestError } = recorder();
		const { events, logger } = capture();
		const startup = new Error("startup");

		await expect(
			createApplication([boom], {
				onRequestError,
				services: {
					names: ["clock"],
					factory: () => {
						throw startup;
					},
				},
			}),
		).rejects.toBe(startup);

		const app = createHonoApp(
			[
				get("/x", () => ({ type: "ok", data: { ok: true } }), {
					services: {
						method: scope(({ onCleanup }) => {
							onCleanup(() => {
								throw new Error("cleanup");
							});
							return { audit: {} };
						}),
					},
				}),
			],
			{ logger, onRequestError },
		);
		app.get("/hono", () => {
			throw new Error("hono");
		});

		expect((await app.request("/x")).status).toBe(200);
		expect((await app.request("/hono")).status).toBe(500);
		expect(events.map((event) => event.event)).toContain("services.cleanup_failed");
		expect(calls).toEqual([]);
	});
});

describe("request error reporter (types)", () => {
	it("LOG-AC-13 types the diagnostic readonly with fixed codes and stages", () => {
		typesOnly(() => {
			const reporter: RequestErrorReporter = (error, diagnostic) => {
				expectType<unknown>(error);
				expectType<RequestErrorCode>(diagnostic.code);
				expectType<"unexpected_failure" | "contract_violation">(diagnostic.code);
				expectType<RequestErrorStage>(diagnostic.stage);
				expectType<string>(diagnostic.requestId);
				expectType<string | undefined>(diagnostic.correlationId);
				expectType<string>(diagnostic.method);
				expectType<string>(diagnostic.route);
				expectType<number>(diagnostic.status);
				// @ts-expect-error The diagnostic is readonly.
				diagnostic.status = 200;
				// @ts-expect-error It carries no error message.
				void diagnostic.message;
			};
			createRouta({ onRequestError: reporter });
			createRouta({ onRequestError: async () => {} });
			// @ts-expect-error A reporter is a function.
			createRouta({ onRequestError: "report" });
			// @ts-expect-error The stage set is fixed.
			const stage: RequestErrorStage = "database";
			void stage;
		});
	});
});

function typesOnly(_check: () => void): void {}

function expectType<T>(_value: T): void {}
