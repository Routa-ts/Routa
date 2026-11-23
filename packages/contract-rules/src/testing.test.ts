import { describe, expect, it } from "vite-plus/test";
import { expectNoLeak } from "./testing.js";

describe("expectNoLeak", () => {
	it("passes when the output does not contain the secret", () => {
		expect(() => expectNoLeak("request failed", "hunter2-password")).not.toThrow();
		expect(() => expectNoLeak({ status: 500 }, "hunter2-password")).not.toThrow();
	});

	it("fails when a string carries the secret", () => {
		expect(() => expectNoLeak("db hunter2-password rejected", "hunter2-password")).toThrow(
			'Expected the output not to contain "hunter2-password"',
		);
	});

	it("checks other output as JSON", () => {
		expect(() =>
			expectNoLeak([{ data: { message: "hunter2-password" } }], "hunter2-password"),
		).toThrow('Expected the output not to contain "hunter2-password"');
	});

	it("accepts a secret of exactly 8 characters with one that is not a hex digit or dash", () => {
		expect(() => expectNoLeak("request failed", "abcdef-g")).not.toThrow();
	});

	it("rejects a secret a random ID could contain by chance", () => {
		for (const secret of ["hunter2", "abc", "ABCDEF12", "0a1b-2c3d-4e5f", ""]) {
			expect(() => expectNoLeak("anything", secret)).toThrow(
				"expectNoLeak needs a distinctive secret",
			);
		}
	});
});
