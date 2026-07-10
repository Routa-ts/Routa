import { describe, expect, it } from "vitest";
import { Fields, Sort } from "./helpers.js";

describe("query helpers", () => {
	it("parses ascending and descending sort fields", () => {
		const schema = Sort(["createdAt", "email"]);

		expect(schema.parse("createdAt")).toEqual({
			field: "createdAt",
			direction: "asc",
		});
		expect(schema.parse("-email")).toEqual({
			field: "email",
			direction: "desc",
		});
	});

	it("rejects unknown sort fields", () => {
		const schema = Sort(["createdAt", "email"]);

		expect(schema.safeParse("-name").success).toBe(false);
	});

	it("parses comma-separated fields", () => {
		const schema = Fields(["id", "email", "createdAt"]);

		expect(schema.parse("id,email")).toEqual(["id", "email"]);
	});

	it("trims whitespace and drops empty field segments", () => {
		const schema = Fields(["id", "email", "createdAt"]);

		expect(schema.parse(" id , email , ")).toEqual(["id", "email"]);
	});

	it("rejects unknown fields", () => {
		const schema = Fields(["id", "email", "createdAt"]);

		expect(schema.safeParse("id,name").success).toBe(false);
	});
});
