import { describe, it } from "vite-plus/test";
import { z } from "zod";
import { createMiddleware, createRoute } from "./index.js";

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
			run: () => ({ type: "unauthorized", headers: { "www-authenticate": "Bearer" } }),
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

function expectType<T>(_value: T): void {}
