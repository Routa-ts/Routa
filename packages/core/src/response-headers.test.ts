import { describe, expect, it } from "vite-plus/test";
import { z } from "zod";
import { createHonoApp, type HonoRoute } from "./hono.js";
import { createMiddleware, createRoute } from "./index.js";
import { createLogger, type RoutaLogEvent } from "./logger.js";

describe("declared response headers (types)", () => {
	it("infers required and optional handler header fields", () => {
		createRoute({
			responses: {
				ok: {
					status: 200,
					schema: z.object({ id: z.string() }),
					headers: z.object({
						etag: z.string(),
						"x-total-count": z.number(),
						"x-cached": z.boolean().optional(),
					}),
				},
			},
			run: ({ response }) => {
				// @ts-expect-error Required headers must be provided.
				response.ok({ id: "1" });
				// @ts-expect-error Required headers cannot be left out.
				response.ok({ id: "1" }, { etag: "a" });
				// @ts-expect-error Header values keep their declared type.
				response.ok({ id: "1" }, { etag: "a", "x-total-count": "3" });
				const built = response.ok({ id: "1" }, { etag: "a", "x-total-count": 3 });
				expectType<string>(built.headers.etag);
				expectType<number>(built.headers["x-total-count"]);
				expectType<boolean | undefined>(built.headers["x-cached"]);
				return built;
			},
		});

		createRoute({
			responses: {
				ok: {
					status: 200,
					schema: z.object({ id: z.string() }),
					headers: z.object({ etag: z.string(), "x-cached": z.boolean().optional() }),
				},
			},
			run: () => ({
				type: "ok",
				data: { id: "1" },
				headers: { etag: "a", "x-cached": true },
			}),
		});
	});

	it("rejects a result that omits required headers or writes undeclared ones", () => {
		createRoute({
			responses: {
				ok: { status: 200, headers: z.object({ etag: z.string() }) },
			},
			// @ts-expect-error A required header is missing.
			run: () => ({ type: "ok" }),
		});

		createRoute({
			responses: {
				ok: { status: 200, headers: z.object({ etag: z.string() }) },
			},
			run: ({ response }) =>
				// @ts-expect-error The `x-extra` header is not declared.
				response.ok({ etag: "a", "x-extra": "b" }),
		});

		createRoute({
			responses: {
				ok: { status: 200, headers: z.object({ etag: z.string() }) },
			},
			// @ts-expect-error The `etag` value must be a string.
			run: () => ({ type: "ok", headers: { etag: 1 } }),
		});
	});

	it("makes the headers field optional when every declared header is optional", () => {
		createRoute({
			responses: {
				ok: { status: 200, headers: z.object({ "retry-after": z.number().optional() }) },
			},
			run: () => ({ type: "ok" }),
		});

		createRoute({
			responses: {
				ok: {
					status: 200,
					schema: z.object({ id: z.string() }),
					headers: z.object({ "retry-after": z.number().optional() }),
				},
			},
			run: ({ response }) => response.ok({ id: "1" }),
		});
	});

	it("forbids headers on outcomes that declare none", () => {
		createRoute({
			responses: {
				ok: { status: 200, schema: z.object({ id: z.string() }) },
			},
			// @ts-expect-error The outcome declares no headers.
			run: () => ({ type: "ok", data: { id: "1" }, headers: { etag: "a" } }),
		});

		createRoute({
			responses: {
				ok: { status: 200, schema: z.object({ id: z.string() }) },
			},
			run: ({ response }) =>
				// @ts-expect-error The outcome declares no headers, so its builder takes none.
				response.ok({ id: "1" }, { etag: "a" }),
		});
	});

	it("builds bodyless outcomes from their headers alone", () => {
		createRoute({
			responses: {
				created: { status: 201, headers: z.object({ location: z.string() }) },
			},
			run: ({ response }) => {
				// @ts-expect-error A bodyless outcome with required headers needs them.
				response.created();
				return response.created({ location: "/items/1" });
			},
		});

		createRoute({
			responses: {
				notModified: { status: 304, headers: z.object({ etag: z.string() }) },
			},
			run: () => ({ type: "notModified", headers: { etag: "a" } }),
		});
	});

	it("accepts literal and enum header values", () => {
		createRoute({
			responses: {
				ok: {
					status: 200,
					headers: z.object({
						"cache-control": z.literal("no-store"),
						"x-mode": z.enum(["fast", "slow"]),
						"x-version": z.union([z.literal(1), z.literal(2)]),
					}),
				},
			},
			run: () => ({
				type: "ok",
				headers: {
					"cache-control": "no-store" as const,
					"x-mode": "fast" as const,
					"x-version": 2 as const,
				},
			}),
		});
	});

	it("applies to middleware rejects", () => {
		createMiddleware({
			rejects: {
				unauthorized: {
					status: 401,
					headers: z.object({ "www-authenticate": z.string() }),
				},
			},
			run: () => ({
				type: "unauthorized" as const,
				headers: { "www-authenticate": "Bearer" },
			}),
		});

		createMiddleware({
			rejects: {
				unauthorized: {
					status: 401,
					headers: z.object({ "www-authenticate": z.string() }),
				},
			},
			// @ts-expect-error The reject requires its declared header.
			run: () => ({ type: "unauthorized" }),
		});
	});
});

describe("response header declarations (types)", () => {
	it("rejects header names that are not lowercase", () => {
		createRoute({
			responses: {
				ok: {
					status: 200,
					// @ts-expect-error Header names must be lowercase.
					headers: z.object({ ETag: z.string() }),
				},
			},
			run: () => ({ type: "ok", headers: { ETag: "a" } }),
		});
	});

	it("rejects headers that Routa owns", () => {
		createRoute({
			responses: {
				// @ts-expect-error Routa owns content-type.
				a: { status: 200, headers: z.object({ "content-type": z.string() }) },
				// @ts-expect-error Routa owns content-length.
				b: { status: 200, headers: z.object({ "content-length": z.number() }) },
				// @ts-expect-error Routa owns transfer-encoding.
				c: { status: 200, headers: z.object({ "transfer-encoding": z.string() }) },
				// @ts-expect-error Routa owns connection.
				d: { status: 200, headers: z.object({ connection: z.string() }) },
				// @ts-expect-error Routa owns set-cookie.
				e: { status: 200, headers: z.object({ "set-cookie": z.string() }) },
			},
			run: () => ({ type: "a", headers: {} }) as never,
		});
	});

	it("rejects values other than strings, numbers, and booleans", () => {
		createRoute({
			responses: {
				ok: {
					status: 200,
					// @ts-expect-error Header values must be strings, numbers, or booleans.
					headers: z.object({ "x-tags": z.array(z.string()) }),
				},
			},
			run: () => ({ type: "ok", headers: { "x-tags": ["a"] } }),
		});

		createRoute({
			responses: {
				ok: {
					status: 200,
					// @ts-expect-error A null header value has no serialization.
					headers: z.object({ "x-maybe": z.string().nullable() }),
				},
			},
			run: () => ({ type: "ok", headers: { "x-maybe": null } }),
		});
	});

	it("rejects header schemas that change values", () => {
		createRoute({
			responses: {
				ok: {
					status: 200,
					// @ts-expect-error Header schemas must not change values.
					headers: z.object({ etag: z.string().transform((value) => value.trim()) }),
				},
			},
			run: () => ({ type: "ok", headers: { etag: "a" } }),
		});

		createRoute({
			responses: {
				ok: {
					status: 200,
					// @ts-expect-error Header schemas must not change values.
					headers: z.object({ "x-limit": z.number().default(10) }),
				},
			},
			run: () => ({ type: "ok", headers: { "x-limit": 1 } }),
		});
	});

	it("keeps existing outcomes without headers source-compatible", () => {
		createRoute({
			responses: {
				ok: { status: 200, schema: z.object({ id: z.string() }) },
				gone: { status: 410 },
			},
			run: ({ response }) => response.ok({ id: "1" }),
		});
	});
});

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

function appFor(
	route: HonoRoute,
	mode: Mode,
	events: RoutaLogEvent[] = [],
	options: Parameters<typeof createHonoApp>[1] = {},
) {
	return createHonoApp([route], {
		...mode.options,
		...options,
		logger: createLogger({ sink: (event) => events.push(event) }),
	});
}

/** A hand-built contract, so declarations and results that TypeScript would reject reach the runtime. */
function handBuilt(
	responses: Record<string, unknown>,
	result: unknown,
	extra: Record<string, unknown> = {},
): HonoRoute {
	return {
		method: "get",
		path: "/item",
		contract: { responses, run: () => result, ...extra } as never,
	};
}

describe("response headers at runtime", () => {
	it("serializes strings, numbers, and booleans next to the JSON body in every mode", async () => {
		for (const mode of modes) {
			const response = await appFor(
				{
					method: "get",
					path: "/item",
					contract: createRoute({
						responses: {
							ok: {
								status: 200,
								schema: z.object({ id: z.string() }),
								headers: z.object({
									etag: z.string(),
									"x-total-count": z.number(),
									"x-cached": z.boolean(),
									"x-fraction": z.number(),
								}),
							},
						},
						run: ({ response }) =>
							response.ok(
								{ id: "1" },
								{ etag: '"v1"', "x-total-count": 42, "x-cached": false, "x-fraction": 0.5 },
							),
					}),
				},
				mode,
			).request("/item");

			expect(response.status, mode.name).toBe(200);
			expect(response.headers.get("etag"), mode.name).toBe('"v1"');
			expect(response.headers.get("x-total-count"), mode.name).toBe("42");
			expect(response.headers.get("x-cached"), mode.name).toBe("false");
			expect(response.headers.get("x-fraction"), mode.name).toBe("0.5");
			expect(response.headers.get("content-type"), mode.name).toBe(
				"application/json; charset=utf-8",
			);
			await expect(response.json(), mode.name).resolves.toEqual({ id: "1" });
		}
	});

	it("omits optional headers that are absent or undefined", async () => {
		for (const mode of modes) {
			const route = (headers: unknown): HonoRoute => ({
				method: "get",
				path: "/item",
				contract: createRoute({
					responses: {
						ok: {
							status: 200,
							headers: z.object({ "retry-after": z.number().optional() }),
						},
					},
					run: () => ({ type: "ok", headers: headers as never }),
				}),
			});

			for (const headers of [undefined, {}, { "retry-after": undefined }]) {
				const response = await appFor(route(headers), mode).request("/item");

				expect(response.status, mode.name).toBe(200);
				expect(response.headers.has("retry-after"), mode.name).toBe(false);
			}

			const present = await appFor(route({ "retry-after": 120 }), mode).request("/item");
			expect(present.headers.get("retry-after"), mode.name).toBe("120");
		}
	});

	it("lets bodyless outcomes emit declared headers and never gives them content headers", async () => {
		for (const mode of modes) {
			const app = createHonoApp(
				[
					{
						method: "post",
						path: "/items",
						contract: createRoute({
							responses: {
								created: { status: 201, headers: z.object({ location: z.string() }) },
							},
							run: ({ response }) => response.created({ location: "/items/1" }),
						}),
					},
					{
						method: "get",
						path: "/items/1",
						contract: createRoute({
							responses: {
								notModified: { status: 304, headers: z.object({ etag: z.string() }) },
								ok: { status: 200, schema: z.object({ id: z.string() }) },
							},
							run: () => ({ type: "notModified", headers: { etag: '"v1"' } }),
						}),
					},
					{
						method: "delete",
						path: "/items/1",
						contract: createRoute({
							responses: {
								removed: {
									status: 204,
									headers: z.object({ "cache-control": z.literal("no-store") }),
								},
							},
							run: () => ({
								type: "removed",
								headers: { "cache-control": "no-store" as const },
							}),
						}),
					},
				],
				mode.options,
			);

			const created = await app.request("/items", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			});
			expect(created.status, mode.name).toBe(201);
			expect(created.headers.get("location"), mode.name).toBe("/items/1");
			expect(created.headers.has("content-type"), mode.name).toBe(false);
			expect(created.headers.has("content-length"), mode.name).toBe(false);
			await expect(created.text(), mode.name).resolves.toBe("");

			const notModified = await app.request("/items/1");
			expect(notModified.status, mode.name).toBe(304);
			expect(notModified.headers.get("etag"), mode.name).toBe('"v1"');
			expect(notModified.headers.has("content-type"), mode.name).toBe(false);

			const removed = await app.request("/items/1", { method: "DELETE" });
			expect(removed.status, mode.name).toBe(204);
			expect(removed.headers.get("cache-control"), mode.name).toBe("no-store");
			expect(removed.headers.has("content-type"), mode.name).toBe(false);
		}
	});

	it("emits headers declared by a terminal middleware reject through the same path", async () => {
		const route: HonoRoute = {
			method: "get",
			path: "/item",
			contract: createRoute({
				middleware: [
					createMiddleware({
						rejects: {
							unauthorized: {
								status: 401,
								headers: z.object({ "www-authenticate": z.string() }),
							},
						},
						run: () => ({
							type: "unauthorized" as const,
							headers: { "www-authenticate": "Bearer" },
						}),
					}),
				],
				responses: { ok: { status: 200 } },
				run: () => ({ type: "ok" }),
			}),
		};

		for (const mode of modes) {
			const response = await appFor(route, mode).request("/item");

			expect(response.status, mode.name).toBe(401);
			expect(response.headers.get("www-authenticate"), mode.name).toBe("Bearer");
		}
	});
});

describe("response header ownership (runtime)", () => {
	const declared = { ok: { status: 200, headers: z.object({ etag: z.string() }) } };

	const failures: Array<{ name: string; responses: Record<string, unknown>; result: unknown }> = [
		{ name: "a required header is missing", responses: declared, result: { type: "ok" } },
		{
			name: "a required header is undefined",
			responses: declared,
			result: { type: "ok", headers: { etag: undefined } },
		},
		{
			name: "an undeclared header is written",
			responses: declared,
			result: { type: "ok", headers: { etag: "a", "x-extra": "b" } },
		},
		{
			name: "headers are written to an outcome that declares none",
			responses: { ok: { status: 200 } },
			result: { type: "ok", headers: { etag: "a" } },
		},
		{
			name: "a header differs from a declared one only in case",
			responses: declared,
			result: { type: "ok", headers: { ETag: "a" } },
		},
		{
			name: "two keys name one header in different case",
			responses: declared,
			result: { type: "ok", headers: { etag: "a", ETag: "b" } },
		},
		{
			name: "a reserved content header is written",
			responses: declared,
			result: { type: "ok", headers: { etag: "a", "content-type": "text/plain" } },
		},
		{
			name: "set-cookie is written as a header",
			responses: declared,
			result: { type: "ok", headers: { etag: "a", "Set-Cookie": "id=1" } },
		},
		{
			name: "headers is not an object",
			responses: declared,
			result: { type: "ok", headers: [["etag", "a"]] },
		},
		{
			name: "headers is a Headers instance",
			responses: declared,
			result: { type: "ok", headers: new Headers({ etag: "a" }) },
		},
	];

	it("fails every violation in every mode, without overwriting", async () => {
		for (const mode of modes) {
			for (const failure of failures) {
				const response = await appFor(handBuilt(failure.responses, failure.result), mode).request(
					"/item",
				);

				expect(response.status, `${mode.name}: ${failure.name}`).toBe(500);
				expect(response.headers.get("content-type"), `${mode.name}: ${failure.name}`).toBe(
					"application/json; charset=utf-8",
				);
				expect(response.headers.has("etag"), `${mode.name}: ${failure.name}`).toBe(false);
				expect(response.headers.has("set-cookie"), `${mode.name}: ${failure.name}`).toBe(false);
				expect(response.headers.has("x-extra"), `${mode.name}: ${failure.name}`).toBe(false);
			}
		}
	});

	it("names the offending header in the logged failure, never its value", async () => {
		const events: RoutaLogEvent[] = [];

		await appFor(
			handBuilt(declared, {
				type: "ok",
				headers: { etag: "secret-value", "x-extra": "secret-too" },
			}),
			modes[0],
			events,
		).request("/item");

		const logged = JSON.stringify(events);
		expect(logged).toContain("x-extra");
		expect(logged).not.toContain("secret-value");
		expect(logged).not.toContain("secret-too");
	});
});

describe("response header transport safety (runtime)", () => {
	const responses = {
		ok: {
			status: 200,
			headers: z.object({ "x-value": z.union([z.string(), z.number(), z.boolean()]) }),
		},
	};

	const unsafe: Array<[string, unknown]> = [
		["a line feed", "a\nb"],
		["a carriage return", "a\rb"],
		["a header-splitting sequence", "a\r\nx-injected: 1"],
		["a null byte", "a\u0000b"],
		["a control character", "a\u0007b"],
		["a character beyond Latin-1", "caf\u20ac"],
		["leading whitespace", " a"],
		["trailing whitespace", "a "],
		["NaN", Number.NaN],
		["Infinity", Number.POSITIVE_INFINITY],
		["null", null],
		["an object", { a: 1 }],
		["an array", ["a"]],
		["a bigint", 1n],
	];

	it("fails unsafe or unserializable values in every mode", async () => {
		for (const mode of modes) {
			for (const [name, value] of unsafe) {
				const response = await appFor(
					handBuilt(responses, { type: "ok", headers: { "x-value": value } }),
					mode,
				).request("/item");

				expect(response.status, `${mode.name}: ${name}`).toBe(500);
				expect(response.headers.has("x-injected"), `${mode.name}: ${name}`).toBe(false);
				expect(response.headers.has("x-value"), `${mode.name}: ${name}`).toBe(false);
			}
		}
	});

	it("serializes the same value the same way every time", async () => {
		for (const [value, text] of [
			[0, "0"],
			[-0, "0"],
			[-1.5, "-1.5"],
			[1e21, "1e+21"],
			[true, "true"],
			["", ""],
			["a b\tc", "a b\tc"],
		] as const) {
			const response = await appFor(
				handBuilt(responses, { type: "ok", headers: { "x-value": value } }),
				modes[1],
			).request("/item");

			expect(response.status, String(value)).toBe(200);
			expect(response.headers.get("x-value"), String(value)).toBe(text);
		}
	});
});

describe("response header validation policy", () => {
	function route(headers: z.ZodObject, value: unknown): HonoRoute {
		return handBuilt({ ok: { status: 200, headers } }, { type: "ok", headers: value });
	}

	it("fails a value its schema rejects only when validation is enabled", async () => {
		for (const mode of modes) {
			const response = await appFor(
				route(z.object({ "x-code": z.string().min(3) }), { "x-code": "ab" }),
				mode,
			).request("/item");

			expect(response.status, mode.name).toBe(mode.validates ? 500 : 200);
			if (!mode.validates) {
				expect(response.headers.get("x-code"), mode.name).toBe("ab");
			}
		}
	});

	it("fails a same-type change and never sends the changed value", async () => {
		for (const mode of modes) {
			const events: RoutaLogEvent[] = [];
			const response = await appFor(
				route(z.object({ etag: z.string().trim().toLowerCase() }), { etag: "ABC" }),
				mode,
				events,
			).request("/item");

			expect(response.status, mode.name).toBe(mode.validates ? 500 : 200);
			expect(response.headers.get("etag"), mode.name).toBe(mode.validates ? null : "ABC");
			expect(JSON.stringify(events), mode.name).not.toContain("ABC");
		}
	});

	it("passes values that already match their schema in every mode", async () => {
		for (const mode of modes) {
			const response = await appFor(
				route(
					z.object({
						"x-mode": z.enum(["fast", "slow"]),
						"x-code": z.string().min(2).max(4),
						"x-limit": z.number().int().optional(),
					}),
					{ "x-mode": "fast", "x-code": "abc" },
				),
				mode,
			).request("/item");

			expect(response.status, mode.name).toBe(200);
		}
	});

	it("keeps the structural checks in production even when Zod parsing is skipped", async () => {
		const response = await appFor(
			route(z.object({ etag: z.string() }), { etag: "a", "x-extra": "b" }),
			modes[1],
		).request("/item");

		expect(response.status).toBe(500);
	});
});

describe("response header declarations at registration", () => {
	function register(
		headers: unknown,
		options: Parameters<typeof createHonoApp>[1] = {},
		extra = {},
	) {
		return () =>
			createHonoApp([handBuilt({ ok: { status: 200, headers } }, { type: "ok" }, extra)], options);
	}

	it("accepts supported declarations", () => {
		expect(
			register(
				z.object({
					etag: z.string(),
					"x-count": z.number().int().optional(),
					"x-flag": z.boolean(),
					"x-mode": z.enum(["a", "b"]),
					"x-fixed": z.literal("fixed"),
					"x-version": z.union([z.literal(1), z.literal(2)]),
					"x-id": z
						.string()
						.min(1)
						.max(10)
						.regex(/^[a-z]+$/),
				}),
			),
		).not.toThrow();
	});

	it("rejects names that are not lowercase", () => {
		expect(register(z.object({ ETag: z.string() }))).toThrow(/"ETag".*lowercase/);
	});

	it("rejects names that collide in case", () => {
		expect(register(z.object({ ETag: z.string(), etag: z.string() }))).toThrow(
			/"ETag".*"etag".*differ only in case/,
		);
	});

	it("rejects names that are not valid header names", () => {
		expect(register(z.object({ "x bad": z.string() }))).toThrow(/"x bad".*not a valid header name/);
	});

	it("rejects names Routa owns", () => {
		for (const name of [
			"content-type",
			"content-length",
			"transfer-encoding",
			"connection",
			"set-cookie",
		]) {
			expect(register(z.object({ [name]: z.string() })), name).toThrow(
				new RegExp(`"${name}".*owns`),
			);
		}
	});

	it("points set-cookie at the cookie capability", () => {
		expect(register(z.object({ "set-cookie": z.string() }))).toThrow(/cookie/i);
	});

	it("rejects values other than strings, numbers, and booleans", () => {
		for (const schema of [
			z.array(z.string()),
			z.object({ a: z.string() }),
			z.string().nullable(),
			z.null(),
			z.unknown(),
			z.bigint(),
			z.string().transform((value) => value.length),
		]) {
			expect(register(z.object({ "x-value": schema })), schema.type).toThrow(
				/"x-value".*string, number, or boolean/,
			);
		}
	});

	it("rejects a headers declaration that is not a Zod object", () => {
		expect(register(z.string())).toThrow(/z\.object/);
		expect(register({ etag: z.string() })).toThrow(/z\.object/);
	});

	it("rejects invalid declarations on middleware rejects", () => {
		expect(() =>
			createHonoApp([
				handBuilt(
					{ ok: { status: 200 } },
					{ type: "ok" },
					{
						middleware: [
							{
								rejects: {
									bad: { status: 401, headers: z.object({ "Content-Type": z.string() }) },
								},
							},
						],
					},
				),
			]),
		).toThrow(/Middleware reject "bad".*"Content-Type"/);
	});
});

describe("lifecycle response headers", () => {
	const deprecated = {
		sunset: "Wed, 01 Jan 2031 00:00:00 GMT",
		replacement: "https://example.com/v2/item",
	};

	function lifecycleRoute(
		deprecation: object | undefined,
		headers?: z.ZodObject,
		result: unknown = { type: "ok" },
	): HonoRoute {
		return handBuilt({ ok: { status: 200, ...(headers ? { headers } : {}) } }, result, {
			deprecation,
		});
	}

	it("emits Deprecation, Sunset, and the successor Link when enabled", async () => {
		for (const mode of modes) {
			const response = await appFor(lifecycleRoute(deprecated), mode, [], {
				lifecycleHeaders: true,
			}).request("/item");

			expect(response.status, mode.name).toBe(200);
			expect(response.headers.get("deprecation"), mode.name).toBe("true");
			expect(response.headers.get("sunset"), mode.name).toBe(deprecated.sunset);
			expect(response.headers.get("link"), mode.name).toBe(
				'<https://example.com/v2/item>; rel="successor-version"',
			);
		}
	});

	it("emits only the lifecycle headers the deprecation declares", async () => {
		const response = await appFor(lifecycleRoute({}), modes[1], [], {
			lifecycleHeaders: true,
		}).request("/item");

		expect(response.headers.get("deprecation")).toBe("true");
		expect(response.headers.has("sunset")).toBe(false);
		expect(response.headers.has("link")).toBe(false);
	});

	it("emits nothing when lifecycle headers are off or the route is not deprecated", async () => {
		for (const [name, route, options] of [
			["disabled", lifecycleRoute(deprecated), {}],
			["explicitly disabled", lifecycleRoute(deprecated), { lifecycleHeaders: false }],
			["not deprecated", lifecycleRoute(undefined), { lifecycleHeaders: true }],
		] as const) {
			const response = await appFor(route, modes[1], [], options).request("/item");

			expect(response.status, name).toBe(200);
			expect(response.headers.has("deprecation"), name).toBe(false);
			expect(response.headers.has("sunset"), name).toBe(false);
			expect(response.headers.has("link"), name).toBe(false);
		}
	});

	it("emits them next to declared headers, on bodyless and body outcomes", async () => {
		const app = createHonoApp(
			[
				{
					method: "get",
					path: "/body",
					contract: createRoute({
						deprecation: {},
						responses: {
							ok: {
								status: 200,
								schema: z.object({ id: z.string() }),
								headers: z.object({ etag: z.string() }),
							},
						},
						run: ({ response }) => response.ok({ id: "1" }, { etag: "a" }),
					}),
				},
				{
					method: "get",
					path: "/bodyless",
					contract: createRoute({
						deprecation: {},
						responses: { gone: { status: 410, headers: z.object({ etag: z.string() }) } },
						run: ({ response }) => response.gone({ etag: "b" }),
					}),
				},
			],
			{ lifecycleHeaders: true },
		);

		const body = await app.request("/body");
		expect(body.headers.get("etag")).toBe("a");
		expect(body.headers.get("deprecation")).toBe("true");
		expect(body.headers.get("content-type")).toBe("application/json; charset=utf-8");

		const bodyless = await app.request("/bodyless");
		expect(bodyless.headers.get("etag")).toBe("b");
		expect(bodyless.headers.get("deprecation")).toBe("true");
		expect(bodyless.headers.has("content-type")).toBe(false);
	});

	it("emits them on terminal middleware rejects", async () => {
		const response = await appFor(
			handBuilt(
				{ ok: { status: 200 } },
				{ type: "ok" },
				{
					deprecation: deprecated,
					middleware: [
						{
							rejects: { denied: { status: 403 } },
							run: () => ({ type: "denied" }),
						},
					],
				},
			),
			modes[1],
			[],
			{ lifecycleHeaders: true },
		).request("/item");

		expect(response.status).toBe(403);
		expect(response.headers.get("deprecation")).toBe("true");
	});

	it("rejects an outcome that declares a header the lifecycle owns", () => {
		const options = { lifecycleHeaders: true };

		expect(() =>
			createHonoApp([lifecycleRoute(deprecated, z.object({ deprecation: z.string() }))], options),
		).toThrow(/"deprecation".*lifecycle/);
		expect(() =>
			createHonoApp([lifecycleRoute(deprecated, z.object({ sunset: z.string() }))], options),
		).toThrow(/"sunset".*lifecycle/);
		expect(() =>
			createHonoApp([lifecycleRoute(deprecated, z.object({ link: z.string() }))], options),
		).toThrow(/"link".*lifecycle/);
	});

	it("leaves link to the application when no successor is declared", () => {
		const options = { lifecycleHeaders: true };

		expect(() =>
			createHonoApp([lifecycleRoute({}, z.object({ link: z.string() }))], options),
		).not.toThrow();
		expect(() =>
			createHonoApp([lifecycleRoute({}, z.object({ sunset: z.string() }))], options),
		).toThrow(/"sunset".*lifecycle/);
	});

	it("allows the headers when lifecycle headers are off or the route is not deprecated", () => {
		const headers = z.object({ deprecation: z.string(), sunset: z.string(), link: z.string() });
		const result = { type: "ok", headers: { deprecation: "d", sunset: "s", link: "l" } };

		expect(() => createHonoApp([lifecycleRoute(deprecated, headers, result)])).not.toThrow();
		expect(() =>
			createHonoApp([lifecycleRoute(undefined, headers, result)], { lifecycleHeaders: true }),
		).not.toThrow();
	});

	it("treats the lifecycle names as application headers when lifecycle headers are off", async () => {
		const response = await appFor(
			lifecycleRoute(deprecated, z.object({ deprecation: z.string() }), {
				type: "ok",
				headers: { deprecation: "false" },
			}),
			modes[1],
			[],
			{ lifecycleHeaders: false },
		).request("/item");

		// Lifecycle headers are off, so the application owns the header.
		expect(response.headers.get("deprecation")).toBe("false");
	});
});

function expectType<T>(_value: T): void {}
