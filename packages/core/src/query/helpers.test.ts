import { describe, expect, it } from "vitest";
import { Sort } from "./helpers.js";

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
});
