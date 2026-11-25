import { describe, expect, it } from "vite-plus/test";
import {
	correlationHeaderProblem,
	correlationValueSchema,
	isCorrelationValue,
	isHeaderName,
	reservedResponseHeaders,
} from "./headers.js";

describe("header names", () => {
	it("accepts RFC 9110 tokens in any casing", () => {
		const names = ["x-correlation-id", "X-Trace", "a!#$%&'*+-.^_`|~9"];
		expect(names.filter(isHeaderName)).toEqual(names);
	});

	it("rejects separators, whitespace, non-ASCII, and the empty name", () => {
		expect(["", "x trace", "x:trace", "x,trace", "xé", '"x"'].filter(isHeaderName)).toEqual([]);
	});
});

describe("correlation IDs", () => {
	const values = [
		"",
		"a",
		"trace-1.A_b",
		"a".repeat(128),
		"a".repeat(129),
		"a,b",
		"a b",
		"a/b",
		"é",
	];

	it("accepts one value of 1 to 128 ASCII letters, digits, dots, underscores, and hyphens", () => {
		expect(values.filter(isCorrelationValue)).toEqual(["a", "trace-1.A_b", "a".repeat(128)]);
	});

	it("documents the same grammar in its OpenAPI schema", () => {
		const pattern = new RegExp(correlationValueSchema.pattern);
		const documented = (value: string) =>
			value.length >= correlationValueSchema.minLength
			&& value.length <= correlationValueSchema.maxLength
			&& pattern.test(value);

		expect(correlationValueSchema).toEqual({
			type: "string",
			minLength: 1,
			maxLength: 128,
			pattern: "^[A-Za-z0-9._-]+$",
		});
		expect(values.filter(documented)).toEqual(values.filter(isCorrelationValue));
	});
});

describe("correlation header problems", () => {
	const serviceKey = { kind: "apiKey", name: "serviceKey", header: "X-API-Key" };
	const defaultKey = { kind: "apiKey", name: "serviceKey", header: "x-correlation-id" };
	const conflict = (
		reason: string,
		advice = "one no configured scheme reads and no route declares",
	) => ({
		kind: "conflict",
		reason,
		advice: `Choose a header of its own for correlation, ${advice}. A correlation ID is not a credential and never replaces x-request-id.`,
	});

	it("accepts a header no rule claims", () => {
		expect(correlationHeaderProblem("x-trace-id")).toBeUndefined();
		expect(correlationHeaderProblem("x-correlation-id", [serviceKey])).toBeUndefined();
	});

	it("names x-correlation-id only when the caller checked that no scheme reads it", () => {
		const grammar =
			"Use a header name made of letters, digits, and the characters ! # $ % & ' * + - . ^ _ ` | ~";
		const invalid = (advice: string) => ({
			kind: "invalid",
			reason: "is not a valid header name",
			advice,
		});

		expect(correlationHeaderProblem("x trace")).toEqual(invalid(`${grammar}.`));
		expect(correlationHeaderProblem("x trace", [])).toEqual(
			invalid(`${grammar}, such as x-correlation-id.`),
		);
		expect(correlationHeaderProblem("x trace", [defaultKey])).toEqual(invalid(`${grammar}.`));
		expect(correlationHeaderProblem("Cookie")).toEqual(
			conflict("names cookie, which is a credential header"),
		);
		expect(correlationHeaderProblem("Cookie", [serviceKey])).toEqual(
			conflict("names cookie, which is a credential header", "such as x-correlation-id"),
		);
	});

	it("rejects x-request-id, credential headers, and the headers Routa writes, in any casing", () => {
		const reasons = Object.fromEntries(
			[
				"X-Request-ID",
				"Authorization",
				"proxy-authorization",
				"COOKIE",
				"set-cookie",
				"Content-Type",
				"content-length",
				"transfer-encoding",
				"connection",
				"Allow",
				"access-control-allow-methods",
				"Vary",
				"deprecation",
				"Sunset",
				"link",
				"WWW-Authenticate",
			].map((header) => [header, correlationHeaderProblem(header)?.reason]),
		);

		expect(reasons).toEqual({
			"X-Request-ID": "names x-request-id, which carries the request identity Routa generates",
			Authorization: "names authorization, which is a credential header",
			"proxy-authorization": "names proxy-authorization, which is a credential header",
			COOKIE: "names cookie, which is a credential header",
			"set-cookie": "names set-cookie, which is a credential header",
			"Content-Type": "names content-type, which is a header Routa owns on every response",
			"content-length": "names content-length, which is a header Routa owns on every response",
			"transfer-encoding":
				"names transfer-encoding, which is a header Routa owns on every response",
			connection: "names connection, which is a header Routa owns on every response",
			Allow: "names allow, which is a header Routa sets on automatic OPTIONS and 405 responses",
			"access-control-allow-methods":
				"names access-control-allow-methods, which is a header Routa sets on automatic OPTIONS responses",
			Vary: "names vary, which is a header Routa sets on automatic OPTIONS responses",
			deprecation: "names deprecation, which is a lifecycle header Routa emits",
			Sunset: "names sunset, which is a lifecycle header Routa emits",
			link: "names link, which is a lifecycle header Routa emits",
			"WWW-Authenticate": "names www-authenticate, which carries Routa's authentication challenges",
		});
	});

	it("rejects the header a configured scheme reads its credential from, in any casing", () => {
		const clientCert = { kind: "custom", name: "clientCert", header: "x-client-cert" };

		expect(correlationHeaderProblem("x-api-key", [serviceKey])).toEqual(
			conflict(
				'names x-api-key, which the apiKey scheme "serviceKey" reads its credential from',
				"such as x-correlation-id",
			),
		);
		expect(correlationHeaderProblem("X-Client-CERT", [serviceKey, clientCert])?.reason).toBe(
			'names x-client-cert, which the custom scheme "clientCert" reads its credential from',
		);
		expect(correlationHeaderProblem("X-Correlation-Id", [defaultKey])).toEqual(
			conflict(
				'names x-correlation-id, which the apiKey scheme "serviceKey" reads its credential from',
			),
		);
	});

	it("reports a claimed header before a scheme that reads it", () => {
		const cookieKey = { kind: "apiKey", name: "cookieKey", header: "cookie" };

		expect(correlationHeaderProblem("cookie", [cookieKey])?.reason).toBe(
			"names cookie, which is a credential header",
		);
	});
});

describe("reserved response headers", () => {
	it("lists the headers Routa owns on every response", () => {
		expect(reservedResponseHeaders).toEqual([
			"content-type",
			"content-length",
			"transfer-encoding",
			"connection",
			"set-cookie",
			"x-request-id",
		]);
	});
});
