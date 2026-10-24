import { describe, it } from "vite-plus/test";
import { z } from "zod";
import { createMiddleware, createRoute, createRouteRootFactory } from "./index.js";

const routeRoot = createRouteRootFactory<{
	"/items": Record<never, never>;
}>()("/items");

describe("body outcomes", () => {
	it("keeps the ordinary body outcome form and requires typed data", () => {
		createRoute({
			responses: {
				ok: { status: 200, schema: z.object({ id: z.string() }) },
			},
			run: ({ response }) => {
				// @ts-expect-error A body outcome requires data.
				response.ok();
				// @ts-expect-error Data must match the outcome schema.
				response.ok({ id: 1 });
				const result = response.ok({ id: "1" });
				expectType<"ok">(result.type);
				expectType<string>(result.data.id);
				return result;
			},
		});

		createRoute({
			responses: {
				ok: { status: 200, schema: z.object({ id: z.string() }) },
			},
			// @ts-expect-error A body outcome result cannot omit data.
			run: () => ({ type: "ok" }),
		});

		createRoute({
			responses: {
				ok: { status: 200, schema: z.object({ id: z.string() }) },
			},
			run: () => ({ type: "ok", data: { id: "1" } }),
		});
	});

	it("rejects undeclared outcome names even when the data matches another outcome", () => {
		createRoute({
			responses: {
				ok: { status: 200, schema: z.object({ id: z.string() }) },
			},
			// @ts-expect-error "missing" is not a declared outcome.
			run: () => ({ type: "missing", data: { id: "1" } }),
		});

		createRoute({
			responses: {
				ok: { status: 200, schema: z.object({ id: z.string() }) },
			},
			// @ts-expect-error A result type that is not a declared outcome name is rejected.
			run: () => {
				const type: string = "ok";
				return { type, data: { id: "1" } };
			},
		});
	});
});

describe("schema-less outcomes", () => {
	it("builds bodyless results without data and forbids data", () => {
		createRoute({
			responses: {
				ok: { status: 200, schema: z.object({ id: z.string() }) },
				created: { status: 201, description: "Created without a body." },
				gone: { status: 410 },
			},
			run: ({ response }) => {
				// @ts-expect-error A schema-less outcome takes no data.
				response.gone({ id: "1" });
				const result = response.gone();
				expectType<"gone">(result.type);
				return result;
			},
		});

		createRoute({
			responses: {
				gone: { status: 410 },
			},
			run: () => ({ type: "gone" }),
		});

		createRoute({
			responses: {
				gone: { status: 410 },
			},
			// @ts-expect-error A schema-less outcome result cannot carry data.
			run: () => ({ type: "gone", data: { id: "1" } }),
		});

		createRoute({
			responses: {
				gone: { status: 410 },
			},
			// @ts-expect-error Even null data is rejected for a schema-less outcome.
			run: () => ({ type: "gone", data: null }),
		});
	});
});

describe("terminal status rules", () => {
	it("rejects body schemas on 204, 205, and 304", () => {
		createRoute({
			responses: {
				noContent: { status: 204 },
				reset: { status: 205 },
				notModified: { status: 304 },
			},
			run: ({ response }) => response.noContent(),
		});

		createRoute({
			responses: {
				noContent: {
					status: 204,
					// @ts-expect-error 204 cannot declare a body schema.
					schema: z.null(),
				},
			},
			run: () => ({ type: "noContent", data: null }),
		});
		createRoute({
			responses: {
				reset: {
					status: 205,
					// @ts-expect-error 205 cannot declare a body schema.
					schema: z.unknown(),
				},
			},
			run: () => ({ type: "reset", data: undefined }),
		});
		createRoute({
			responses: {
				notModified: {
					status: 304,
					// @ts-expect-error 304 cannot declare a body schema.
					schema: z.object({}),
				},
			},
			run: () => ({ type: "notModified", data: {} }),
		});
	});

	it("rejects informational statuses as terminal outcomes", () => {
		createRoute({
			responses: {
				// @ts-expect-error 1xx statuses cannot be terminal outcomes.
				early: { status: 103 },
			},
			run: () => ({ type: "early" }),
		});
		createRoute({
			responses: {
				// @ts-expect-error 1xx statuses cannot be terminal outcomes.
				switching: { status: 101, schema: z.object({}) },
			},
			run: () => ({ type: "switching", data: {} }),
		});
	});

	it("rejects every HEAD outcome that declares a body", () => {
		routeRoot({
			head: createRoute({
				responses: { ok: { status: 200 } },
				run: () => ({ type: "ok" }),
			}),
		});

		routeRoot({
			// @ts-expect-error HEAD outcomes cannot declare a body schema.
			head: createRoute({
				responses: {
					ok: { status: 200, schema: z.object({ ok: z.boolean() }) },
				},
				run: () => ({ type: "ok", data: { ok: true } }),
			}),
		});
	});

	it("limits 304 to GET and HEAD", () => {
		routeRoot({
			get: createRoute({
				responses: {
					ok: { status: 200, schema: z.object({ id: z.string() }) },
					notModified: { status: 304 },
				},
				run: () => ({ type: "notModified" }),
			}),
			head: createRoute({
				responses: { notModified: { status: 304 } },
				run: () => ({ type: "notModified" }),
			}),
		});

		routeRoot({
			// @ts-expect-error 304 is valid only for GET and HEAD.
			post: createRoute({
				responses: {
					ok: { status: 201, schema: z.object({ id: z.string() }) },
					notModified: { status: 304 },
				},
				run: () => ({ type: "ok", data: { id: "1" } }),
			}),
		});
	});

	it("applies schema-less outcomes to middleware rejects", () => {
		createMiddleware({
			rejects: { forbidden: { status: 403 } },
			run: () => ({ type: "forbidden" }),
		});
	});
});

describe("response schemas that change values", () => {
	it("rejects schemas whose input and output types differ", () => {
		createRoute({
			responses: {
				ok: {
					status: 200,
					// @ts-expect-error z.coerce changes the value type.
					schema: z.coerce.number(),
				},
			},
			run: () => ({ type: "ok", data: 1 }),
		});
		createRoute({
			responses: {
				ok: {
					status: 200,
					// @ts-expect-error .default() makes input and output differ.
					schema: z.object({ name: z.string().default("x") }),
				},
			},
			run: () => ({ type: "ok", data: { name: "x" } }),
		});
		createRoute({
			responses: {
				ok: {
					status: 200,
					// @ts-expect-error .catch() makes input and output differ.
					schema: z.string().catch("x"),
				},
			},
			run: () => ({ type: "ok", data: "x" }),
		});
	});

	it("rejects known transformer wrappers", () => {
		createRoute({
			responses: {
				ok: {
					status: 200,
					// @ts-expect-error .transform() is a response mutation.
					schema: z.string().transform((value) => value.toUpperCase()),
				},
			},
			run: () => ({ type: "ok", data: "A" }),
		});
		createRoute({
			responses: {
				ok: {
					status: 200,
					// @ts-expect-error A nested transform is a response mutation.
					schema: z.object({ name: z.string().transform((value) => value.toUpperCase()) }),
				},
			},
			run: () => ({ type: "ok", data: { name: "A" } }),
		});
		createRoute({
			responses: {
				ok: {
					status: 200,
					// @ts-expect-error A transform inside an array is a response mutation.
					schema: z.array(z.string().transform((value) => value.trim())),
				},
			},
			run: () => ({ type: "ok", data: [] }),
		});
		createRoute({
			responses: {
				ok: {
					status: 200,
					// @ts-expect-error A transform inside a union is a response mutation.
					schema: z.union([z.string(), z.number().transform((value) => String(value))]),
				},
			},
			run: () => ({ type: "ok", data: "1" }),
		});
		createRoute({
			responses: {
				ok: {
					status: 200,
					// @ts-expect-error z.preprocess is a response mutation.
					schema: z.preprocess((value) => value, z.string()),
				},
			},
			run: () => ({ type: "ok", data: "A" }),
		});
		createRoute({
			responses: {
				ok: {
					status: 200,
					// @ts-expect-error Codecs are excluded from response schemas.
					schema: z.codec(z.string(), z.string(), {
						decode: (value) => value,
						encode: (value) => value,
					}),
				},
			},
			run: () => ({ type: "ok", data: "A" }),
		});
	});

	it("applies to middleware rejects", () => {
		createMiddleware({
			rejects: {
				// @ts-expect-error A reject schema must not change values.
				bad: { status: 400, schema: z.string().transform((value) => value.trim()) },
			},
			run: () => ({ type: "bad", data: "x" }),
		});
	});

	it("accepts wire-ready schemas", () => {
		createRoute({
			responses: {
				ok: {
					status: 200,
					schema: z.object({
						id: z.string().min(1),
						email: z.string().pipe(z.email()),
						tags: z.array(z.string()).optional(),
						owner: z.object({ name: z.string() }).nullable(),
						kind: z.union([z.literal("a"), z.literal("b")]),
						scores: z.record(z.string(), z.number()),
						pair: z.tuple([z.string(), z.number()]),
					}),
				},
			},
			run: () => ({
				type: "ok",
				data: {
					id: "1",
					email: "a@example.com",
					owner: null,
					kind: "a" as const,
					scores: {},
					pair: ["x", 1] as [string, number],
				},
			}),
		});
	});
});

function expectType<T>(_value: T): void {}
