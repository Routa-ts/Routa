import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { createHonoApp, type HonoRoute } from "./hono.js";
import { createMiddleware, createRoute } from "./index.js";
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

function appFor(route: HonoRoute, mode: Mode, events: RoutaLogEvent[] = []) {
	return createHonoApp([route], {
		...mode.options,
		logger: createLogger({ sink: (event) => events.push(event) }),
	});
}

describe("body outcomes", () => {
	it("serializes the handler value as JSON in every mode", async () => {
		for (const mode of modes) {
			const app = appFor(
				{
					method: "get",
					path: "/item",
					contract: createRoute({
						responses: { ok: { status: 200, schema: z.object({ id: z.string() }) } },
						run: () => ({ type: "ok", data: { id: "1" } }),
					}),
				},
				mode,
			);

			const response = await app.request("/item");

			expect(response.status, mode.name).toBe(200);
			expect(response.headers.get("content-type"), mode.name).toBe(
				"application/json; charset=utf-8",
			);
			await expect(response.json(), mode.name).resolves.toEqual({ id: "1" });
		}
	});

	it("fails a body outcome that returns no data in every mode", async () => {
		for (const mode of modes) {
			const app = appFor(
				{
					method: "get",
					path: "/item",
					contract: createRoute({
						responses: { ok: { status: 200, schema: z.object({ id: z.string() }) } },
						run: () => ({ type: "ok" }) as never,
					}),
				},
				mode,
			);

			expect((await app.request("/item")).status, mode.name).toBe(500);
		}
	});

	it("fails an undeclared outcome name in every mode", async () => {
		for (const mode of modes) {
			const app = appFor(
				{
					method: "get",
					path: "/item",
					contract: createRoute({
						responses: { ok: { status: 200, schema: z.object({ id: z.string() }) } },
						run: () => ({ type: "missing", data: { id: "1" } }) as never,
					}),
				},
				mode,
			);

			expect((await app.request("/item")).status, mode.name).toBe(500);
		}
	});

	it("fails data that cannot be serialized as JSON in every mode", async () => {
		for (const mode of modes) {
			const app = appFor(
				{
					method: "get",
					path: "/item",
					contract: createRoute({
						responses: { ok: { status: 200, schema: z.unknown() } },
						run: () => ({ type: "ok", data: undefined }),
					}),
				},
				mode,
			);

			expect((await app.request("/item")).status, mode.name).toBe(500);
		}
	});
});

describe("schema-less outcomes", () => {
	const route = (data?: unknown): HonoRoute => ({
		method: "get",
		path: "/item",
		contract: createRoute({
			responses: {
				ok: { status: 200, schema: z.object({ id: z.string() }) },
				gone: { status: 410, description: "The item was removed." },
			},
			run: () => (data === undefined ? { type: "gone" } : { type: "gone", data }) as never,
		}),
	});

	it("sends an empty body without a content type, even for a non-terminal-body status", async () => {
		for (const mode of modes) {
			const response = await appFor(route(), mode).request("/item");

			expect(response.status, mode.name).toBe(410);
			expect(response.headers.get("content-type"), mode.name).toBeNull();
			await expect(response.text(), mode.name).resolves.toBe("");
		}
	});

	it("fails when the handler returns data, even null, in every mode", async () => {
		for (const mode of modes) {
			for (const data of [{ id: "1" }, null, "text"]) {
				const response = await appFor(route(data), mode).request("/item");

				expect(response.status, `${mode.name} ${JSON.stringify(data)}`).toBe(500);
			}
		}
	});
});

describe("response validation policy", () => {
	function profileRoute(data: unknown, schema: z.ZodTypeAny): HonoRoute {
		return {
			method: "get",
			path: "/profile",
			// Hand-built so schemas that TypeScript would reject can still reach the runtime.
			contract: {
				responses: { ok: { status: 200, schema } },
				run: () => ({ type: "ok", data }),
			} as never,
		};
	}

	it("fails a body that does not match its schema only when validation is enabled", async () => {
		for (const mode of modes) {
			const response = await appFor(
				profileRoute({ id: 1 }, z.object({ id: z.string() })),
				mode,
			).request("/profile");

			expect(response.status, mode.name).toBe(mode.validates ? 500 : 200);
		}
	});

	it("fails a same-type value change and sends the handler value when not validating", async () => {
		const schema = z.object({ email: z.string().trim().toLowerCase() });

		for (const mode of modes) {
			const events: RoutaLogEvent[] = [];
			const response = await appFor(
				profileRoute({ email: " Jane@Example.com " }, schema),
				mode,
				events,
			).request("/profile");

			expect(response.status, mode.name).toBe(mode.validates ? 500 : 200);
			if (mode.validates) {
				expect(JSON.stringify(events), mode.name).not.toContain("Jane@Example.com");
			} else {
				await expect(response.json(), mode.name).resolves.toEqual({
					email: " Jane@Example.com ",
				});
			}
		}
	});

	it("fails a URL that Zod would trim, and never sends the trimmed URL", async () => {
		const schema = z.object({ link: z.url() });

		for (const mode of modes) {
			const response = await appFor(
				profileRoute({ link: "  https://example.com/a " }, schema),
				mode,
			).request("/profile");

			expect(response.status, mode.name).toBe(mode.validates ? 500 : 200);
			if (!mode.validates) {
				await expect(response.json(), mode.name).resolves.toEqual({
					link: "  https://example.com/a ",
				});
			}
		}
	});

	it("fails unknown keys that the schema would strip", async () => {
		const schema = z.object({ id: z.string() });

		for (const mode of modes) {
			const response = await appFor(
				profileRoute({ id: "1", secret: "hunter2" }, schema),
				mode,
			).request("/profile");

			expect(response.status, mode.name).toBe(mode.validates ? 500 : 200);
		}
	});

	it("accepts equivalent values, including reordered keys, missing optionals, and dates as strings", async () => {
		const schema = z.object({
			b: z.number(),
			a: z.string(),
			note: z.string().optional(),
			tags: z.array(z.string()),
		});

		for (const mode of modes) {
			const response = await appFor(
				profileRoute({ a: "x", b: 1, tags: ["t"], note: undefined }, schema),
				mode,
			).request("/profile");

			expect(response.status, mode.name).toBe(200);
		}
	});

	it("validates middleware rejects with the same policy", async () => {
		const reject = createMiddleware({
			rejects: {
				denied: { status: 403, schema: z.object({ reason: z.string().trim() }) },
			},
			run: () => ({ type: "denied", data: { reason: " no " } }) as never,
		});

		for (const mode of modes) {
			const app = appFor(
				{
					method: "get",
					path: "/secure",
					contract: createRoute({
						middleware: [reject],
						responses: { ok: { status: 200, schema: z.object({ ok: z.boolean() }) } },
						run: () => ({ type: "ok", data: { ok: true } }),
					}),
				},
				mode,
			);

			expect((await app.request("/secure")).status, mode.name).toBe(mode.validates ? 500 : 403);
		}
	});

	it("applies the structural checks to middleware rejects in every mode", async () => {
		const reject = createMiddleware({
			rejects: { denied: { status: 403 } },
			run: () => ({ type: "denied", data: { reason: "no" } }) as never,
		});

		for (const mode of modes) {
			const app = appFor(
				{
					method: "get",
					path: "/secure",
					contract: createRoute({
						middleware: [reject],
						responses: { ok: { status: 200, schema: z.object({ ok: z.boolean() }) } },
						run: () => ({ type: "ok", data: { ok: true } }),
					}),
				},
				mode,
			);

			expect((await app.request("/secure")).status, mode.name).toBe(500);
		}
	});

	it("sends an empty body for a schema-less middleware reject", async () => {
		const reject = createMiddleware({
			rejects: { denied: { status: 403, description: "Not allowed." } },
			run: () => ({ type: "denied" }),
		});
		const app = appFor(
			{
				method: "get",
				path: "/secure",
				contract: createRoute({
					middleware: [reject],
					responses: { ok: { status: 200, schema: z.object({ ok: z.boolean() }) } },
					run: () => ({ type: "ok", data: { ok: true } }),
				}),
			},
			modes[0]!,
		);

		const response = await app.request("/secure");

		expect(response.status).toBe(403);
		await expect(response.text()).resolves.toBe("");
	});
});

describe("outcome declaration rules at registration", () => {
	function register(method: HonoRoute["method"], responses: Record<string, unknown>) {
		return () =>
			createHonoApp([
				{
					method,
					path: "/item",
					contract: {
						responses,
						run: () => ({ type: "ok" }),
					} as never,
				},
			]);
	}

	it("rejects informational statuses as terminal outcomes", () => {
		expect(register("get", { early: { status: 103 } })).toThrow(
			'Outcome "early" on GET /item declares status 103. Informational (1xx)',
		);
	});

	it("rejects body schemas on 204, 205, and 304", () => {
		for (const status of [204, 205, 304]) {
			expect(register("get", { none: { status, schema: z.null() } })).toThrow(
				`Outcome "none" on GET /item declares a schema for status ${status}`,
			);
		}
	});

	it("rejects a body schema on every HEAD outcome", () => {
		expect(register("head", { ok: { status: 200, schema: z.object({}) } })).toThrow(
			'Outcome "ok" on HEAD /item declares a schema, but HEAD responses have no body',
		);
		expect(register("head", { ok: { status: 200 } })).not.toThrow();
	});

	it("allows 304 only for GET and HEAD", () => {
		expect(register("get", { cached: { status: 304 } })).not.toThrow();
		expect(register("head", { cached: { status: 304 } })).not.toThrow();
		for (const method of ["post", "put", "patch", "delete"] as const) {
			expect(register(method, { cached: { status: 304 } })).toThrow(
				`Outcome "cached" on ${method.toUpperCase()} /item declares status 304`,
			);
		}
	});

	it("applies the status rules to middleware rejects", () => {
		expect(() =>
			createHonoApp([
				{
					method: "get",
					path: "/item",
					contract: {
						responses: { ok: { status: 200 } },
						middleware: [{ rejects: { bad: { status: 204, schema: z.null() } } }],
						run: () => ({ type: "ok" }),
					} as never,
				},
			]),
		).toThrow('Middleware reject "bad" on GET /item declares a schema for status 204');
	});
});
