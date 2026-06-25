import { describe, expect, it } from "vitest";
import { z } from "zod";
import { createMiddleware, createRoute, defineRoute } from "./index.js";

describe("route contracts", () => {
	it("preserves route method declarations", () => {
		const requireAuth = createMiddleware({
			provides: ["user"],
		});

		const route = defineRoute({
			post: createRoute({
				input: {
					body: z.object({
						email: z.string().email(),
					}),
				},
				responses: {
					success: {
						status: 201,
						schema: z.object({
							id: z.string(),
						}),
					},
				},
				middleware: [requireAuth],
				run: ({ ctx }) => {
					expectType<unknown>(ctx.user);
					return { type: "success", data: { id: "usr_1" } };
				},
			}),
		});

		expect(route.post.responses.success.status).toBe(201);
	});
});

function expectType<T>(_value: T): void {}
