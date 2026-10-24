import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { createHonoApp, type HonoRoute } from "./hono.js";
import { createCookie, createMiddleware, createRoute } from "./index.js";
import { planCookies } from "./response-cookies.js";
import { createLogger, type RoutaLogEvent } from "./logger.js";

type Mode = { name: string; options: Parameters<typeof createHonoApp>[1]; validates: boolean };

const modes: Mode[] = [
	{ name: "development", options: { runtimeMode: "dev" }, validates: true },
	{
		name: "production by default",
		options: { runtimeMode: "start", responseValidation: "development" },
		validates: false,
	},
	{
		name: "production with always",
		options: { runtimeMode: "start", responseValidation: "always" },
		validates: true,
	},
];

const session = createCookie({
	name: "session",
	schema: z.string(),
	httpOnly: true,
	secure: true,
	sameSite: "lax",
	path: "/",
	maxAge: 3600,
});

const theme = createCookie({
	name: "theme",
	schema: z.enum(["light", "dark"]),
	httpOnly: false,
	secure: false,
	sameSite: "strict",
	path: "/app",
	domain: "example.com",
});

function appFor(route: HonoRoute, mode: Mode = modes[0]!, events: RoutaLogEvent[] = []) {
	return createHonoApp([route], {
		...mode.options,
		logger: createLogger({ sink: (event) => events.push(event) }),
	});
}

function expectType<T>(_value: T): void {}

/** Type fixtures: compiled, never run, so invalid declarations do not throw. */
function typesOnly(_check: () => void): void {}

describe("response cookies (types)", () => {
	it("types set and clear effects and binds them to the declaring outcome", () => {
		createRoute({
			responses: {
				ok: { status: 200, schema: z.object({ id: z.string() }), cookies: [session, theme] },
			},
			run: () => {
				const set = session.set("abc");
				expectType<"set" | "clear">(set.kind);
				return {
					type: "ok",
					data: { id: "1" },
					cookies: [set, theme.set("dark"), session.clear()],
				};
			},
		});
	});

	it("rejects values that do not match the handle's schema", () => {
		// @ts-expect-error The session value is a string.
		session.set(1);
		// @ts-expect-error The theme value is "light" or "dark".
		theme.set("blue");
	});

	it("rejects effects for handles the outcome does not declare", () => {
		createRoute({
			responses: { ok: { status: 200, cookies: [session] } },
			// @ts-expect-error `theme` is not declared on this outcome.
			run: () => ({ type: "ok", cookies: [theme.set("dark")] }),
		});
	});

	it("forbids cookies on an outcome that declares none", () => {
		createRoute({
			responses: { ok: { status: 200 } },
			// @ts-expect-error The outcome declares no cookies.
			run: () => ({ type: "ok", cookies: [session.set("abc")] }),
		});
	});

	it("keeps outcomes without cookies source-compatible", () => {
		createRoute({
			responses: { ok: { status: 200, schema: z.object({ id: z.string() }) } },
			run: ({ response }) => response.ok({ id: "1" }),
		});
	});
});

describe("response cookies at runtime", () => {
	it("sends set and clear effects as repeated Set-Cookie fields in every mode", async () => {
		for (const mode of modes) {
			const response = await appFor(
				{
					method: "get",
					path: "/item",
					contract: createRoute({
						responses: {
							ok: { status: 200, schema: z.object({ id: z.string() }), cookies: [session, theme] },
						},
						run: () => ({
							type: "ok",
							data: { id: "1" },
							cookies: [session.set("abc 123"), theme.clear()],
						}),
					}),
				},
				mode,
			).request("/item");

			expect(response.status, mode.name).toBe(200);
			expect(response.headers.getSetCookie(), mode.name).toEqual([
				"session=abc%20123; Path=/; Max-Age=3600; HttpOnly; Secure; SameSite=Lax",
				"theme=; Domain=example.com; Path=/app; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; SameSite=Strict",
			]);
			await expect(response.json(), mode.name).resolves.toEqual({ id: "1" });
		}
	});

	it("sends cookies from a bodyless outcome without content headers", async () => {
		const response = await appFor({
			method: "post",
			path: "/logout",
			contract: createRoute({
				responses: { done: { status: 204, cookies: [session] } },
				run: () => ({ type: "done", cookies: [session.clear()] }),
			}),
		}).request("/logout", { method: "POST" });

		expect(response.status).toBe(204);
		expect(response.headers.has("content-type")).toBe(false);
		expect(response.headers.getSetCookie()).toHaveLength(1);
	});

	it("sends no Set-Cookie when a declared cookie is not emitted", async () => {
		const response = await appFor({
			method: "get",
			path: "/item",
			contract: createRoute({
				responses: { ok: { status: 200, cookies: [session] } },
				run: () => ({ type: "ok" }),
			}),
		}).request("/item");

		expect(response.headers.getSetCookie()).toEqual([]);
	});
});

const base = {
	schema: z.string(),
	httpOnly: true,
	secure: true,
	sameSite: "lax",
	path: "/",
} as const;

describe("response cookie rules", () => {
	it("enforces SameSite=None, Partitioned, and prefix rules in types", () => {
		typesOnly(() => {
			// @ts-expect-error SameSite=None requires Secure.
			createCookie({ ...base, name: "a", secure: false, sameSite: "none" });
			createCookie({ ...base, name: "a", sameSite: "none" });
			// @ts-expect-error Partitioned requires Secure.
			createCookie({ ...base, name: "a", secure: false, partitioned: true });
			// @ts-expect-error The __Secure- prefix requires Secure.
			createCookie({ ...base, name: "__Secure-a", secure: false });
			createCookie({ ...base, name: "__Secure-a" });
			// @ts-expect-error The __Host- prefix requires Secure.
			createCookie({ ...base, name: "__Host-a", secure: false });
			// @ts-expect-error The __Host- prefix requires Path=/.
			createCookie({ ...base, name: "__Host-a", path: "/app" });
			// @ts-expect-error The __Host- prefix forbids Domain.
			createCookie({ ...base, name: "__Host-a", domain: "example.com" });
			createCookie({ ...base, name: "__Host-a" });
		});
	});

	it("requires every explicit attribute in types", () => {
		typesOnly(() => {
			// @ts-expect-error httpOnly is required.
			createCookie({ name: "a", schema: z.string(), secure: true, sameSite: "lax", path: "/" });
			// @ts-expect-error secure is required.
			createCookie({ name: "a", schema: z.string(), httpOnly: true, sameSite: "lax", path: "/" });
			// @ts-expect-error sameSite is required.
			createCookie({ name: "a", schema: z.string(), httpOnly: true, secure: true, path: "/" });
			// @ts-expect-error path is required.
			createCookie({
				name: "a",
				schema: z.string(),
				httpOnly: true,
				secure: true,
				sameSite: "lax",
			});
		});
	});

	it("rejects value schemas that are not scalar or that change values", () => {
		typesOnly(() => {
			// @ts-expect-error A cookie value is a string, number, or boolean.
			createCookie({ ...base, name: "a", schema: z.object({ id: z.string() }) });
			// @ts-expect-error A cookie schema must not transform its value.
			createCookie({ ...base, name: "a", schema: z.string().transform((value) => value.length) });
			// @ts-expect-error A cookie schema must not default its value.
			createCookie({ ...base, name: "a", schema: z.string().default("x") });
		});
	});

	it("types numbers and booleans as set values", () => {
		const count = createCookie({ ...base, name: "count", schema: z.number() });
		const flag = createCookie({ ...base, name: "flag", schema: z.boolean() });

		count.set(1);
		flag.set(true);
		// @ts-expect-error The count value is a number.
		count.set("1");
	});

	it("enforces the same rules when a cookie is created at runtime", () => {
		const cases: Array<[string, Record<string, unknown>]> = [
			["name", { name: "bad name" }],
			["name", { name: "a;b" }],
			["name", { name: "" }],
			["sameSite", { sameSite: "none", secure: false }],
			["partitioned", { partitioned: true, secure: false }],
			["__Secure-", { name: "__Secure-a", secure: false }],
			["__Secure-", { name: "__secure-a", secure: false }],
			["__Host-", { name: "__Host-a", secure: false }],
			["__Host-", { name: "__Host-a", path: "/app" }],
			["__Host-", { name: "__Host-a", domain: "example.com" }],
			["path", { path: "app" }],
			["path", { path: "/a;b" }],
			["path", { path: "/app " }],
			["path", { path: "/app\t" }],
			["path", { path: " /app" }],
			["path", { path: "/Ā" }],
			["path", { path: "/日本" }],
			["path", { path: "/é" }],
			["path", { path: "/a\u007fb" }],
			["domain", { domain: " example.com" }],
			["domain", { domain: "example.com " }],
			["domain", { domain: "例え.com" }],
			["domain", { domain: "bad domain" }],
			["domain", { domain: "a;b.com" }],
			["maxAge", { maxAge: -1 }],
			["maxAge", { maxAge: 1.5 }],
			["expires", { expires: "tomorrow" }],
			["httpOnly", { httpOnly: undefined }],
			["secure", { secure: undefined }],
			["sameSite", { sameSite: "Lax" }],
			["value", { schema: z.object({}) }],
			["value", { schema: z.string().transform((value) => value) }],
		];

		for (const [label, overrides] of cases) {
			expect(
				() => createCookie({ ...base, name: "a", ...overrides } as never),
				`${label} ${JSON.stringify(overrides)}`,
			).toThrow(/Cookie/);
		}

		expect(() =>
			createCookie({
				...base,
				name: "a",
				domain: ".example.com",
				expires: "2030-01-01T00:00:00Z",
				partitioned: true,
			}),
		).not.toThrow();
	});

	it("keeps identity and security attributes when clearing", async () => {
		const cookie = createCookie({
			...base,
			name: "id",
			domain: "example.com",
			path: "/app",
			maxAge: 60,
			expires: "2030-01-01T00:00:00Z",
			sameSite: "none",
			partitioned: true,
		});
		const response = await appFor({
			method: "get",
			path: "/a",
			contract: createRoute({
				responses: { ok: { status: 200, cookies: [cookie] } },
				run: () => ({ type: "ok", cookies: [cookie.clear()] }),
			}),
		}).request("/a");

		expect(response.headers.getSetCookie()).toEqual([
			"id=; Domain=example.com; Path=/app; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; HttpOnly; Secure; SameSite=None; Partitioned",
		]);
	});

	it("serializes a set effect with every attribute in a fixed order", async () => {
		const cookie = createCookie({
			...base,
			name: "id",
			domain: "example.com",
			path: "/app",
			maxAge: 60,
			expires: "2030-01-01T00:00:00Z",
			sameSite: "none",
			partitioned: true,
		});
		const response = await appFor({
			method: "get",
			path: "/a",
			contract: createRoute({
				responses: { ok: { status: 200, cookies: [cookie] } },
				run: () => ({ type: "ok", cookies: [cookie.set("v")] }),
			}),
		}).request("/a");

		expect(response.headers.getSetCookie()).toEqual([
			"id=v; Domain=example.com; Path=/app; Expires=Tue, 01 Jan 2030 00:00:00 GMT; Max-Age=60; HttpOnly; Secure; SameSite=None; Partitioned",
		]);
	});
});

describe("response cookie encoding", () => {
	const cookie = createCookie({ ...base, name: "v", schema: z.string() });
	const count = createCookie({ ...base, name: "n", schema: z.number() });
	const flag = createCookie({ ...base, name: "b", schema: z.boolean() });

	const send = async (effects: unknown[], mode: Mode) =>
		appFor(
			{
				method: "get",
				path: "/a",
				contract: createRoute({
					responses: { ok: { status: 200, cookies: [cookie, count, flag] } },
					run: () => ({ type: "ok", cookies: effects as never }),
				}),
			},
			mode,
		).request("/a");

	it("percent-encodes values so only cookie octets reach the wire, in every mode", async () => {
		for (const mode of modes) {
			const response = await send(
				[cookie.set('a b;c,d"e\\f=g\r\nSet-Cookie: x=1é€'), count.set(-1.5), flag.set(false)],
				mode,
			);

			const [text, number, boolean] = response.headers.getSetCookie();
			expect(text, mode.name).toBe(
				"v=a%20b%3Bc%2Cd%22e%5Cf%3Dg%0D%0ASet-Cookie%3A%20x%3D1%C3%A9%E2%82%AC; Path=/; HttpOnly; Secure; SameSite=Lax",
			);
			expect(number, mode.name).toBe("n=-1.5; Path=/; HttpOnly; Secure; SameSite=Lax");
			expect(boolean, mode.name).toBe("b=false; Path=/; HttpOnly; Secure; SameSite=Lax");
			expect(response.headers.getSetCookie().length, mode.name).toBe(3);
		}
	});

	it("round-trips an encoded value through the request cookie parser", async () => {
		const value = 'a b;c,d"é€ 100%';
		const response = await send([cookie.set(value)], modes[0]!);
		const pair = response.headers.getSetCookie()[0]!.split(";")[0]!;
		const app = createHonoApp([
			{
				method: "get",
				path: "/echo",
				contract: createRoute({
					input: { cookies: z.object({ v: z.string() }) },
					responses: { ok: { status: 200, schema: z.object({ v: z.string() }) } },
					run: ({ input }) => ({ type: "ok", data: { v: input.cookies.v } }),
				}),
			},
		]);

		const echoed = await app.request("/echo", { headers: { cookie: pair } });
		await expect(echoed.json()).resolves.toEqual({ v: value });
	});

	it("rejects values that cannot be encoded safely, in every mode", async () => {
		for (const mode of modes) {
			for (const value of ["\ud800", Number.NaN, Number.POSITIVE_INFINITY, {}, null, undefined]) {
				const kind =
					typeof value === "string" ? cookie : typeof value === "number" ? count : cookie;
				const response = await send([{ kind: "set", cookie: kind, value }], mode);

				expect(response.status, `${mode.name} ${String(value)}`).toBe(500);
				expect(response.headers.getSetCookie()).toEqual([]);
			}
		}
	});
});

describe("response cookie path safety", () => {
	it("accepts printable ASCII paths and percent-encoded literals", () => {
		for (const path of ["/", "/app", "/a b", "/caf%C3%A9", "/a/b?c=d#e"]) {
			expect(() => createCookie({ ...base, name: "a", path }), path).not.toThrow();
		}
	});

	it("rejects the /app and /app-with-a-space pair, so they never collide on the wire", () => {
		expect(() => createCookie({ ...base, name: "session", path: "/app" })).not.toThrow();
		expect(() => createCookie({ ...base, name: "session", path: "/app " })).toThrow(/path/);
	});

	it("sends an encoded non-ASCII scope, keeping distinct encoded scopes distinct, in every mode", async () => {
		const accented = createCookie({ ...base, name: "session", path: "/caf%C3%A9" });
		const spaced = createCookie({ ...base, name: "session", path: "/app%20" });
		const plain = createCookie({ ...base, name: "session", path: "/app" });

		for (const mode of modes) {
			const response = await appFor(
				{
					method: "get",
					path: "/a",
					contract: createRoute({
						responses: { ok: { status: 200, cookies: [accented, spaced, plain] } },
						run: () => ({
							type: "ok",
							cookies: [accented.set("x"), spaced.set("y"), plain.set("z")],
						}),
					}),
				},
				mode,
			).request("/a");

			expect(response.status, mode.name).toBe(200);
			expect(response.headers.getSetCookie(), mode.name).toEqual([
				"session=x; Path=/caf%C3%A9; HttpOnly; Secure; SameSite=Lax",
				"session=y; Path=/app%20; HttpOnly; Secure; SameSite=Lax",
				"session=z; Path=/app; HttpOnly; Secure; SameSite=Lax",
			]);
		}
	});
});

describe("response cookie ownership", () => {
	const other = createCookie({ ...base, name: "other" });
	const sameName = createCookie({ ...base, name: "session", path: "/admin" });
	const routeFor = (cookies: unknown[], effects: unknown) =>
		({
			method: "get",
			path: "/a",
			contract: createRoute({
				responses: { ok: { status: 200, cookies: cookies as never } },
				run: () => ({ type: "ok", cookies: effects as never }),
			}),
		}) satisfies HonoRoute;

	it("fails effects for handles the outcome does not declare, in every mode", async () => {
		for (const mode of modes) {
			const response = await appFor(routeFor([session], [other.set("x")]), mode).request("/a");

			expect(response.status, mode.name).toBe(500);
			expect(response.headers.getSetCookie(), mode.name).toEqual([]);
		}
	});

	it("fails a handle whose identity matches a declared one but is a different object", async () => {
		const twin = createCookie({ ...base, name: "session", maxAge: 3600 });
		const response = await appFor(routeFor([session], [twin.set("x")])).request("/a");

		expect(response.status).toBe(500);
	});

	it("fails effects that are not from createCookie, in every mode", async () => {
		for (const mode of modes) {
			for (const effects of [
				"session=x",
				["session=x"],
				[{ kind: "set", cookie: { ...session }, value: "x" }],
				[{ kind: "set", cookie: session.name, value: "x" }],
				[{ kind: "delete", cookie: session }],
				[null],
				{},
			]) {
				const response = await appFor(routeFor([session], effects), mode).request("/a");

				expect(response.status, `${mode.name} ${JSON.stringify(effects)}`).toBe(500);
			}
		}
	});

	it("fails cookies written to an outcome that declares none", async () => {
		const response = await appFor({
			method: "get",
			path: "/a",
			contract: createRoute({
				responses: { ok: { status: 200 } },
				// @ts-expect-error The outcome declares no cookies.
				run: () => ({ type: "ok", cookies: [session.set("x")] }),
			}),
		}).request("/a");

		expect(response.status).toBe(500);
		expect(response.headers.getSetCookie()).toEqual([]);
	});

	it("fails the same identity emitted twice and sends nothing", async () => {
		for (const effects of [
			[session.set("a"), session.set("b")],
			[session.set("a"), session.clear()],
			[session.clear(), session.clear()],
		]) {
			const response = await appFor(routeFor([session], effects)).request("/a");

			expect(response.status).toBe(500);
			expect(response.headers.getSetCookie()).toEqual([]);
		}
	});

	it("allows the same name with different scopes and sends both as separate fields", async () => {
		const events: RoutaLogEvent[] = [];
		const response = await appFor(
			routeFor([session, sameName], [session.set("a"), sameName.set("b")]),
			modes[0]!,
			events,
		).request("/a");

		expect(response.status).toBe(200);
		expect(response.headers.getSetCookie()).toEqual([
			"session=a; Path=/; Max-Age=3600; HttpOnly; Secure; SameSite=Lax",
			"session=b; Path=/admin; HttpOnly; Secure; SameSite=Lax",
		]);
		expect(
			events.filter((event) => event.event === "cookies.scope").map((event) => event.level),
		).toEqual(["warn"]);
	});

	it("never joins repeated cookies with commas", async () => {
		const response = await appFor(
			routeFor([session, other], [session.set("a"), other.set("b")]),
		).request("/a");
		const raw = response.headers.get("set-cookie");

		expect(response.headers.getSetCookie()).toHaveLength(2);
		// `Headers.get` joins repeats with ", " for display; the fields themselves stay separate.
		expect(raw).toBe(response.headers.getSetCookie().join(", "));
	});

	it("fails two producers that claim one identity and joins different identities", () => {
		const entry = (producer: string, name: string, path = "/") => ({
			producer,
			name,
			path,
			field: `${name}=1; Path=${path}`,
		});

		expect(() => planCookies([entry("outcome", "a"), entry("framework", "a")])).toThrow(
			/outcome.*framework|framework.*outcome/,
		);
		expect(planCookies([entry("outcome", "a"), entry("framework", "a", "/x")])).toHaveLength(2);
		expect(() =>
			planCookies([
				{ ...entry("outcome", "a"), domain: "Example.com" },
				{ ...entry("x", "a"), domain: ".example.com" },
			]),
		).toThrow();
	});

	it("rejects raw Set-Cookie headers", async () => {
		expect(() =>
			appFor({
				method: "get",
				path: "/a",
				contract: createRoute({
					// @ts-expect-error Routa owns Set-Cookie; declare cookies instead.
					responses: { ok: { status: 200, headers: z.object({ "set-cookie": z.string() }) } },
					run: () => ({ type: "ok", headers: { "set-cookie": "a=1" } }),
				}),
			}),
		).toThrow(/Set-Cookie/);
	});
});

describe("response cookie declarations at registration", () => {
	it("rejects hand-built, duplicate, and non-array declarations", () => {
		const declare = (cookies: unknown) => () =>
			createHonoApp([
				{
					method: "get",
					path: "/a",
					contract: createRoute({
						responses: { ok: { status: 200, cookies: cookies as never } },
						run: () => ({ type: "ok" }),
					}),
				},
			]);

		expect(declare([session])).not.toThrow();
		expect(declare([{ ...session }])).toThrow(/createCookie/);
		expect(declare([session, session])).toThrow(/more than once/);
		expect(declare("session")).toThrow(/array/);
		expect(declare({ session })).toThrow(/array/);
	});

	it("rejects two declared handles with one identity", () => {
		const twin = createCookie({ ...base, name: "session" });

		expect(() =>
			createHonoApp([
				{
					method: "get",
					path: "/a",
					contract: createRoute({
						responses: { ok: { status: 200, cookies: [session, twin] } },
						run: () => ({ type: "ok" }),
					}),
				},
			]),
		).toThrow(/more than once/);
	});
});

describe("response cookie validation policy", () => {
	const code = createCookie({ ...base, name: "code", schema: z.string().min(3) });
	const trimmed = createCookie({ ...base, name: "trimmed", schema: z.string().trim() });
	const route = (effects: unknown[]) =>
		({
			method: "get",
			path: "/a",
			contract: createRoute({
				responses: { ok: { status: 200, cookies: [code, trimmed] } },
				run: () => ({ type: "ok", cookies: effects as never }),
			}),
		}) satisfies HonoRoute;

	it("parses and compares values in development and production-always, and skips in production by default", async () => {
		for (const mode of modes) {
			const invalid = await appFor(route([code.set("ab")]), mode).request("/a");
			const mutated = await appFor(route([trimmed.set(" x ")]), mode).request("/a");

			expect(invalid.status, mode.name).toBe(mode.validates ? 500 : 200);
			expect(mutated.status, mode.name).toBe(mode.validates ? 500 : 200);

			if (mode.validates) {
				expect(invalid.headers.getSetCookie(), mode.name).toEqual([]);
				expect(mutated.headers.getSetCookie(), mode.name).toEqual([]);
			} else {
				expect(mutated.headers.getSetCookie(), mode.name).toEqual([
					"trimmed=%20x%20; Path=/; HttpOnly; Secure; SameSite=Lax",
				]);
			}
		}
	});

	it("sends the handler value, never the parsed one", async () => {
		const response = await appFor(route([code.set("abc")]), modes[0]!).request("/a");

		expect(response.headers.getSetCookie()).toEqual([
			"code=abc; Path=/; HttpOnly; Secure; SameSite=Lax",
		]);
	});

	it("does not validate a clear effect", async () => {
		const response = await appFor(route([code.clear()]), modes[0]!).request("/a");

		expect(response.status).toBe(200);
	});
});

describe("response cookies from terminal middleware rejects", () => {
	const guard = createMiddleware({
		rejects: {
			expired: { status: 401, cookies: [session] },
		},
		run: async ({ input: _input, next }) => {
			void next;
			return { type: "expired", cookies: [session.clear()] };
		},
	});

	it("sends reject cookies through the same plan as route outcomes", async () => {
		const response = await appFor({
			method: "get",
			path: "/a",
			contract: createRoute({
				middleware: [guard],
				responses: { ok: { status: 200 } },
				run: () => ({ type: "ok" }),
			}),
		}).request("/a");

		expect(response.status).toBe(401);
		expect(response.headers.getSetCookie()).toEqual([
			"session=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=0; HttpOnly; Secure; SameSite=Lax",
		]);
	});

	it("applies the same ownership rules to reject cookies", async () => {
		const bad = createMiddleware({
			rejects: { expired: { status: 401, cookies: [session] } },
			// @ts-expect-error `theme` is not declared on this reject.
			run: () => ({ type: "expired", cookies: [theme.set("dark")] }),
		});
		const response = await appFor({
			method: "get",
			path: "/a",
			contract: createRoute({
				middleware: [bad],
				responses: { ok: { status: 200 } },
				run: () => ({ type: "ok" }),
			}),
		}).request("/a");

		expect(response.status).toBe(500);
		expect(response.headers.getSetCookie()).toEqual([]);
	});

	it("validates reject cookie declarations at registration", () => {
		const hand = createMiddleware({
			rejects: { expired: { status: 401, cookies: [{ ...session }] as never } },
			run: () => ({ type: "expired" }),
		});

		expect(() =>
			appFor({
				method: "get",
				path: "/a",
				contract: createRoute({
					middleware: [hand],
					responses: { ok: { status: 200 } },
					run: () => ({ type: "ok" }),
				}),
			}),
		).toThrow(/createCookie/);
	});
});
