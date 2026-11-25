import { describe, expect, it } from "vite-plus/test";
import { reservedAuthContext, reservedContext } from "./context.js";
import { requestErrorCodes, requestErrorStages } from "./request-errors.js";

describe("reserved context", () => {
	it("reserves the framework's context keys, and ctx.auth separately", () => {
		expect(Object.keys(reservedContext)).toEqual([
			"services",
			"requestId",
			"correlationId",
			"logger",
		]);

		for (const { reason, advice } of [...Object.values(reservedContext), reservedAuthContext]) {
			// Callers write "which Routa reserves for <reason>. <advice>".
			expect(reason).toMatch(/^[a-z][^.]*[a-zA-Z]$/);
			expect(advice).toMatch(/^Rename the context key\.( [^\n]+)?$/);
		}
	});
});

describe("request error vocabulary", () => {
	it("lists the codes and the stages in documentation order", () => {
		expect(requestErrorCodes.map((entry) => entry.name)).toEqual([
			"unexpected_failure",
			"contract_violation",
			"configuration_error",
		]);
		expect(requestErrorStages.map((entry) => entry.name)).toEqual([
			"identity",
			"authentication",
			"context",
			"input",
			"services",
			"middleware",
			"handler",
			"response",
		]);
	});

	it("describes each entry in one line, as a table cell", () => {
		const malformed = [...requestErrorCodes, ...requestErrorStages].filter(
			({ description }) => !/^[A-Z][^\n|]*[^.\s]$/.test(description),
		);
		expect(malformed).toEqual([]);
	});
});
