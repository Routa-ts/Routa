import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vite-plus/test";
import { run } from "./index.js";
import { generateOpenApi } from "./openapi.js";
import { validateProject } from "./project.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const statusRoute = `import { createRoute, createRouteRoot } from "@routa-ts/core";
import { z } from "zod";

export default createRouteRoot("/status")({
\tget: createRoute({
\t\tresponses: {
\t\t\tok: { status: 200, schema: z.object({ requestId: z.string() }) },
\t\t\tgone: { status: 410 },
\t\t},
\t\trun: ({ ctx }) => ({ type: "ok", data: { requestId: ctx.requestId } }),
\t}),
});
`;

function config(members: string, prelude = ""): string {
	return `import { createRouta } from "@routa-ts/core";
${prelude}
export default createRouta({
${members}
});
`;
}

/**
 * A config that reads correlation from `header` and declares a credential scheme of each
 * transport. Every authenticator and extractor writes `sentinel`, so a test can tell whether
 * generation ran one.
 */
function credentialConfig(header: string, sentinel: string): string {
	const ran = `writeFileSync(${JSON.stringify(sentinel)}, "ran")`;
	return config(
		`\tcorrelation: { header: ${JSON.stringify(header)} },
\tauthentication: {
\t\tprincipal: z.object({ type: z.literal("service"), id: z.string() }),
\t\tschemes: {
\t\t\tuserToken: bearer({ authenticate: () => (${ran}, { type: "rejected" }) }),
\t\t\tserviceKey: apiKey({
\t\t\t\theader: "X-Api-Key",
\t\t\t\tauthenticate: (key) =>
\t\t\t\t\t(${ran}, key === "service-key" ? { type: "authenticated", principal: { type: "service", id: "svc_key" } } : { type: "rejected" }),
\t\t\t}),
\t\t\tclientCert: custom({
\t\t\t\ttransport: { header: "X-Client-Cert" },
\t\t\t\topenapi: { type: "mutualTLS" },
\t\t\t\textract: (value) => (${ran}, { type: "credential", credential: value }),
\t\t\t\tauthenticate: (value) =>
\t\t\t\t\t(${ran}, value === "cert-1" ? { type: "authenticated", principal: { type: "service", id: "svc_cert" } } : { type: "rejected" }),
\t\t\t}),
\t\t\tbasicUser: custom({
\t\t\t\ttransport: { header: "authorization", scheme: "Basic" },
\t\t\t\topenapi: { type: "http", scheme: "basic" },
\t\t\t\tauthenticate: () => (${ran}, { type: "rejected" }),
\t\t\t}),
\t\t\tsession: sessionCookie({ cookie: "session", authenticate: () => (${ran}, { type: "rejected" }) }),
\t\t\tdevice: custom({
\t\t\t\ttransport: { cookie: "device" },
\t\t\t\topenapi: { type: "apiKey", in: "cookie", name: "device" },
\t\t\t\tauthenticate: () => (${ran}, { type: "rejected" }),
\t\t\t}),
\t\t},
\t},`,
		`import { writeFileSync } from "node:fs";
import { apiKey, bearer, custom, sessionCookie } from "@routa-ts/core";
import { z } from "zod";
`,
	);
}

const requestIdHeader = {
	required: true,
	description: "The request identity Routa generated for this request.",
	schema: { type: "string", format: "uuid" },
};

function correlationHeader(): Record<string, unknown> {
	return {
		description:
			"The caller's correlation ID, echoed when the request sent one valid value in this header.",
		schema: { type: "string", minLength: 1, maxLength: 128, pattern: "^[A-Za-z0-9._-]+$" },
	};
}

describe("request identity contract", () => {
	it("LOG-AC-11 documents identity headers on every response, deterministically, without running src/routa.ts", async () => {
		const sentinel = join(mkdtempSync(join(tmpdir(), "routa-identity-sentinel-")), "executed");
		const cwd = project({
			"src/logger.ts": `import { writeFileSync } from "node:fs";
import { createLogger } from "@routa-ts/core";

writeFileSync(${JSON.stringify(sentinel)}, "logger module");
export const logger = createLogger({
\tsink: () => writeFileSync(${JSON.stringify(sentinel)}, "logger sink"),
});
`,
			"src/routa.ts": config(
				`\tlogger,\n\tcorrelation: true,`,
				`import { writeFileSync } from "node:fs";\nimport { logger } from "./logger.js";\nwriteFileSync(${JSON.stringify(sentinel)}, "routa module");\n`,
			),
			"src/routes/status/route.ts": statusRoute,
		});

		const generate = await run(["generate"], { cwd });
		const first = JSON.stringify(generateOpenApi(cwd));
		const second = JSON.stringify(generateOpenApi(cwd));

		expect(generate.stderr ?? "").toBe("");
		expect(generate.code).toBe(0);
		expect(existsSync(sentinel)).toBe(false);
		expect(second).toBe(first);
		expect(readFileSync(join(cwd, ".routa/routes.gen.ts"), "utf8")).toContain(
			'export const routaCorrelationHeader = "x-correlation-id";',
		);
		const responses = (JSON.parse(first) as OpenApi).paths["/status"]!.get!.responses;
		expect(responses["200"]!.headers).toEqual({
			"x-request-id": requestIdHeader,
			"x-correlation-id": correlationHeader(),
		});
		expect(responses["410"]!.headers).toEqual({
			"x-request-id": requestIdHeader,
			"x-correlation-id": correlationHeader(),
		});
	});
});

describe("composed identity contract", () => {
	const composedRoute = `import { createCookie, createMiddleware, createRoute, createRouteRoot, requireAuth } from "@routa-ts/core";
import { z } from "zod";

const seen = createCookie({ name: "seen", schema: z.literal("yes"), httpOnly: true, secure: true, sameSite: "lax", path: "/" });

const gate = createMiddleware({
\trequires: ["auth"],
\trejects: {
\t\tclosed: { status: 403, headers: z.object({ "x-reason": z.string() }), schema: z.object({ message: z.string() }) },
\t},
\trun: ({ ctx, next }) =>
\t\tctx.auth.status === "authenticated" && ctx.auth.principal.id === "svc_closed"
\t\t\t? { type: "closed", headers: { "x-reason": "closed" }, data: { message: "Closed" } }
\t\t\t: next(),
});

export default createRouteRoot("/items")({
\tget: createRoute({
\t\tdeprecation: { sunset: "2027-01-01", replacement: "https://api.example.invalid/v2/items" },
\t\tmiddleware: [requireAuth(), gate],
\t\tinput: { query: z.object({ limit: z.coerce.number().int().min(1).optional() }) },
\t\tresponses: {
\t\t\tok: {
\t\t\t\tstatus: 200,
\t\t\t\theaders: z.object({ etag: z.string() }),
\t\t\t\tcookies: [{ handle: seen, required: true }],
\t\t\t\tschema: z.object({ id: z.string() }),
\t\t\t},
\t\t\tgone: { status: 410, headers: z.object({ "x-gone-since": z.string().optional() }) },
\t\t},
\t\trun: ({ ctx, input }) =>
\t\t\tinput.query.limit === 9
\t\t\t\t? { type: "gone", headers: { "x-gone-since": "2026-01-01" } }
\t\t\t\t: {
\t\t\t\t\t\ttype: "ok",
\t\t\t\t\t\theaders: { etag: '"v1"' },
\t\t\t\t\t\tcookies: [seen.set("yes")],
\t\t\t\t\t\tdata: { id: ctx.auth.status === "authenticated" ? ctx.auth.principal.id : "anonymous" },
\t\t\t\t\t},
\t}),
});
`;

	/** Headers HTTP or the operation's deprecation metadata describe, rather than Header Objects. */
	const transport = new Set(["content-type", "content-length", "set-cookie"]);
	const lifecycle = new Set(["deprecation", "sunset", "link"]);

	it("LOG-AC-17 sends the identity headers OpenAPI documents on every response of a composed operation, and generates it deterministically", async () => {
		const sentinel = join(mkdtempSync(join(tmpdir(), "routa-composed-sentinel-")), "executed");
		const cwd = project({
			"src/logger.ts": `import { writeFileSync } from "node:fs";
import { createLogger } from "@routa-ts/core";

writeFileSync(${JSON.stringify(sentinel)}, "logger module");
export const logger = createLogger({ sink: () => {} });
`,
			"src/routa.ts": credentialConfig("X-Trace-Ref", sentinel)
				.replace("\tcorrelation:", "\tlogger,\n\tlifecycleHeaders: true,\n\tcorrelation:")
				.replace(
					"import { z }",
					`import { logger } from "./logger.js";\nwriteFileSync(${JSON.stringify(sentinel)}, "routa module");\nimport { z }`,
				)
				// The service key authenticates, and the route's own gate then rejects it.
				.replace('"svc_key"', '"svc_closed"'),
			"src/routes/items/route.ts": composedRoute,
		});
		const generatedFiles = () =>
			[".routa/routes.gen.ts", ".routa/testing.gen.ts"].map((file) =>
				readFileSync(join(cwd, file), "utf8"),
			);

		const first = await run(["generate"], { cwd });
		expect(first.stderr ?? "", first.stdout).toBe("");
		const before = generatedFiles();
		const openapi = JSON.stringify(generateOpenApi(cwd));
		expect((await run(["generate"], { cwd })).code).toBe(0);
		expect(generatedFiles()).toEqual(before);
		expect(JSON.stringify(generateOpenApi(cwd))).toBe(openapi);
		expect(existsSync(sentinel)).toBe(false);

		const operation = (JSON.parse(openapi) as OpenApi).paths["/items"]!.get as OpenApiOperation;
		const documented = Object.keys(operation.responses).sort();
		// Generated OpenAPI documents outcomes, authentication, and rejects. It does not document
		// framework validation failures, so the 400 below is checked for identity alone.
		expect(documented).toEqual(["200", "401", "403", "410"]);
		for (const status of documented) {
			const headers = operation.responses[status]!.headers!;
			expect(headers["x-request-id"], status).toEqual(requestIdHeader);
			expect(headers["x-trace-ref"], status).toEqual(correlationHeader());
		}

		// Lifecycle headers are documented through the operation's deprecation metadata, which every
		// documented response must then carry exactly.
		expect(operation).toMatchObject({
			deprecated: true,
			"x-routa-sunset": "2027-01-01",
			"x-routa-replacement": "https://api.example.invalid/v2/items",
		});
		const lifecycleSent = {
			deprecation: "true",
			sunset: operation["x-routa-sunset"],
			link: `<${operation["x-routa-replacement"]}>; rel="successor-version"`,
		};

		const app = (await (
			(await import(pathToFileURL(join(cwd, ".routa/testing.gen.ts")).href)) as {
				createTestApp: () => Promise<{
					request: (path: string, init?: RequestInit) => Promise<Response>;
					dispose(): Promise<void>;
				}>;
			}
		).createTestApp())!;
		const requests: Array<[string, Record<string, string>, number]> = [
			["/items", { "x-client-cert": "cert-1" }, 200],
			["/items?limit=9", { "x-client-cert": "cert-1" }, 410],
			["/items?limit=0", { "x-client-cert": "cert-1" }, 400],
			["/items", {}, 401],
			["/items", { "x-api-key": "wrong" }, 401],
			["/items", { "X-Api-Key": "service-key" }, 403],
		];

		for (const [path, headers, status] of requests) {
			for (const correlation of ["trace-1", "not valid"]) {
				const label = `${path} ${JSON.stringify(headers)} ${correlation}`;
				const response = await app.request(path, {
					headers: { ...headers, "x-trace-ref": correlation },
				});
				const documentedResponse = operation.responses[String(response.status)];

				expect(response.status, label).toBe(status);
				expect(response.headers.get("x-request-id"), label).toMatch(
					/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
				);
				expect(response.headers.get("x-trace-ref"), label).toBe(
					correlation === "trace-1" ? "trace-1" : null,
				);

				if (status === 400) {
					expect(documentedResponse, label).toBeUndefined();
					continue;
				}

				expect(documentedResponse, label).toBeDefined();
				expect(
					Object.fromEntries([...response.headers].filter(([name]) => lifecycle.has(name))),
					label,
				).toEqual(lifecycleSent);
				for (const [name, header] of Object.entries(documentedResponse!.headers ?? {})) {
					if ((header as { required?: boolean }).required && name !== "Set-Cookie") {
						expect(response.headers.has(name), `${label} ${name}`).toBe(true);
					}
				}
				// A response sets cookies only when OpenAPI documents Set-Cookie for it, and always does
				// when OpenAPI marks Set-Cookie required.
				const documentedCookie = documentedResponse!.headers?.["Set-Cookie"] as
					| { required?: boolean }
					| undefined;
				const sentCookie = response.headers.getSetCookie().length > 0;
				if (sentCookie) {
					expect(documentedCookie, `${label} Set-Cookie`).toBeDefined();
				}
				if (documentedCookie?.required) {
					expect(sentCookie, `${label} Set-Cookie`).toBe(true);
				}
				for (const [name] of response.headers) {
					if (!lifecycle.has(name) && !transport.has(name)) {
						expect(Object.keys(documentedResponse!.headers ?? {}), `${label} ${name}`).toContain(
							name,
						);
					}
				}
				if (status === 403) {
					// The reject's declared header and body match what OpenAPI documents for them.
					expect(documentedResponse!.headers?.["x-reason"], label).toMatchObject({
						required: true,
						schema: { type: "string" },
					});
					expect(response.headers.get("x-reason"), label).toBe("closed");
					expect(
						(documentedResponse as { content?: Record<string, { schema?: unknown }> }).content?.[
							"application/json"
						]?.schema,
						label,
					).toMatchObject({ type: "object", properties: { message: { type: "string" } } });
					expect(await response.json(), label).toEqual({ message: "Closed" });
				}
				if (status === 410) {
					// The optional declared header is sent and documented.
					const goneSince = documentedResponse!.headers?.["x-gone-since"] as
						| { required?: boolean; schema?: unknown }
						| undefined;
					expect(goneSince?.schema, label).toEqual({ type: "string" });
					expect(goneSince?.required ?? false, label).toBe(false);
					expect(response.headers.get("x-gone-since"), label).toBe("2026-01-01");
				}
				if (status === 200) {
					// The authenticated principal reaches the handler, and the body matches its schema.
					expect(await response.json(), label).toEqual({ id: "svc_cert" });
					expect(
						(documentedResponse as { content?: Record<string, { schema?: unknown }> }).content?.[
							"application/json"
						]?.schema,
						label,
					).toMatchObject({
						type: "object",
						required: ["id"],
						properties: { id: { type: "string" } },
					});
					// The outcome's declared header matches what OpenAPI documents for it.
					expect(documentedResponse!.headers?.["etag"], label).toMatchObject({
						required: true,
						schema: { type: "string" },
					});
					expect(response.headers.get("etag"), label).toBe('"v1"');
					// The declared cookie keeps every attribute its handle declares, and OpenAPI documents
					// the same attributes and that this response always sets it.
					expect(response.headers.get("set-cookie"), label).toBe(
						"seen=yes; Path=/; HttpOnly; Secure; SameSite=Lax",
					);
					const setCookie = documentedResponse!.headers?.["Set-Cookie"] as {
						required?: boolean;
						description?: string;
					};
					expect(setCookie.required, label).toBe(true);
					expect(setCookie.description, label).toContain(
						'"seen" (HttpOnly, Secure, SameSite=Lax, Path=/)',
					);
					expect(setCookie.description, label).toContain('It always sets or clears: "seen".');
					expect(Object.keys(documentedResponse!.headers!), label).toContain("Set-Cookie");
				}
			}
		}

		await app.dispose();
	}, 60_000);
});

describe("generated test applications", () => {
	type TestApp = {
		request: (path: string, init?: RequestInit) => Promise<Response>;
		dispose(): Promise<void>;
	};

	const generated = async (members: string) => {
		const cwd = project({
			"src/routa.ts": config(members),
			"src/routes/status/route.ts": statusRoute,
		});
		const check = await run(["check"], { cwd });
		expect(check.stderr ?? "").toBe("");
		expect(check.code).toBe(0);
		return cwd;
	};
	const testApp = async (cwd: string) =>
		(
			(await import(pathToFileURL(join(cwd, ".routa/testing.gen.ts")).href)) as {
				createTestApp: () => Promise<TestApp>;
			}
		).createTestApp();

	it("LOG-AC-07 identify requests and echo correlation with logging off", async () => {
		const cwd = await generated('\tlogger: false,\n\tcorrelation: { header: "X-Trace-Ref" },');
		const app = await testApp(cwd);

		const response = await app.request("/status", { headers: { "X-TRACE-REF": "trace-1" } });

		expect(await response.json()).toEqual({ requestId: response.headers.get("x-request-id") });
		expect(response.headers.get("x-trace-ref")).toBe("trace-1");
		await app.dispose();
	}, 30_000);

	it("LOG-AC-11 generate and echo correlation configured in a re-exported default", async () => {
		const cwd = project({
			"src/routa.ts": 'export { default } from "./config.js";\n',
			"src/config.ts": config('\tcorrelation: { header: "X-Trace-Ref" },'),
			"src/routes/status/route.ts": statusRoute,
		});
		const check = await run(["check"], { cwd });
		expect(check.stderr ?? "").toBe("");
		expect(check.code).toBe(0);
		expect(readFileSync(join(cwd, ".routa/routes.gen.ts"), "utf8")).toContain(
			'export const routaCorrelationHeader = "x-trace-ref";',
		);
		const openApi = JSON.parse(JSON.stringify(generateOpenApi(cwd))) as OpenApi;
		expect(openApi.paths["/status"]!.get!.responses["200"]!.headers).toEqual({
			"x-request-id": requestIdHeader,
			"x-trace-ref": correlationHeader(),
		});
		const app = await testApp(cwd);

		const response = await app.request("/status", { headers: { "x-trace-ref": "trace-1" } });

		expect(response.headers.get("x-trace-ref")).toBe("trace-1");
		await app.dispose();
	}, 30_000);

	it("LOG-AC-10 leave the configured correlation header to routa check and registration, not TypeScript", async () => {
		// Code outside the route tree, such as a standalone createHonoApp with correlation off, may
		// declare the header; only x-request-id is reserved in the types.
		const declarations = `import { createMiddleware, createRoute } from "@routa-ts/core";
import { z } from "zod";

export const route = createRoute({
\tresponses: {
\t\tok: { status: 200, headers: z.object({ "x-trace-ref": z.string() }) },
\t},
\trun: () => ({ type: "ok", headers: { "x-trace-ref": "x" } }),
});

export const gate = createMiddleware({
\trejects: {
\t\tdenied: { status: 403, headers: z.object({ "x-trace-ref": z.string() }) },
\t},
\trun: ({ next }) => next(),
});

export const owned = createRoute({
\tresponses: {
\t\tok: {
\t\t\tstatus: 200,
\t\t\t// @ts-expect-error Routa owns x-request-id on every response.
\t\t\theaders: z.object({ "x-request-id": z.string() }),
\t\t},
\t},
\trun: () => ({ type: "ok" }) as never,
});
`;
		const cwd = project({
			"src/routa.ts": config('\tcorrelation: { header: "X-Trace-Ref" },'),
			"src/routes/status/route.ts": statusRoute,
			"src/declarations.ts": declarations,
		});
		expect(await run(["generate"], { cwd })).toMatchObject({ code: 0 });
		expect(readFileSync(join(cwd, ".routa/routes.gen.ts"), "utf8")).not.toContain(
			"correlationHeader:",
		);

		const result = await run(["check"], { cwd });
		expect(`${result.stdout ?? ""}${result.stderr ?? ""}`).not.toMatch(/TS\d{4}/);
		expect(result.code).toBe(0);
	}, 60_000);

	it("LOG-AC-11 refuse to start when src/routa.ts changed correlation after generation", async () => {
		const cwd = await generated('\tcorrelation: { header: "X-Trace-Ref" },');
		writeFileSync(join(cwd, "src/routa.ts"), config("\tcorrelation: true,"));

		await expect(testApp(cwd)).rejects.toThrow(
			"src/routa.ts reads correlation from x-correlation-id, but .routa/routes.gen.ts declares x-trace-ref. Run routa generate.",
		);
	}, 30_000);
});

describe("correlation config", () => {
	it("LOG-AC-09 reads correlation from a literal, a const object, or not at all", () => {
		for (const [members, prelude, header] of [
			["\tcorrelation: true,", "", "x-correlation-id"],
			['\tcorrelation: { header: "X-Trace-Ref" },', "", "x-trace-ref"],
			[
				"\tcorrelation,",
				'const correlation = { header: "x-trace-ref" } as const;\n',
				"x-trace-ref",
			],
			['\tcorrelation: { header: "Constructor" },', "", "constructor"],
			['\tcorrelation: { header: "__proto__" },', "", "__proto__"],
			["\tcorrelation: false,", "", undefined],
			["", "", undefined],
		] as const) {
			const result = validateProject(
				project({
					"src/routa.ts": config(members, prelude),
					"src/routes/status/route.ts": statusRoute,
				}),
				{ write: false },
			);
			expect(result.diagnostics, members).toEqual([]);
			expect(result.correlationHeader, members).toBe(header);
		}
	});

	it("LOG-AC-09 rejects correlation config it cannot read, an invalid header, and conflicting headers", () => {
		for (const [members, code, message] of [
			[
				'\tcorrelation: process.env.CORRELATION === "on",',
				"ROUTA_CORRELATION_CONFIG_UNRESOLVED",
				"The correlation config in src/routa.ts cannot be statically read.",
			],
			[
				'\tcorrelation: { header: process.env.CORRELATION_HEADER ?? "x-correlation-id" },',
				"ROUTA_CORRELATION_CONFIG_UNRESOLVED",
				"The correlation config in src/routa.ts cannot be statically read.",
			],
			[
				'\tcorrelation: { header: "x-trace", required: true },',
				"ROUTA_CORRELATION_CONFIG_UNRESOLVED",
				"The correlation config in src/routa.ts cannot be statically read.",
			],
			[
				'\tcorrelation: { header: "x trace" },',
				"ROUTA_CORRELATION_HEADER_INVALID",
				'The correlation header "x trace" in src/routa.ts is not a valid header name.',
			],
			[
				'\tcorrelation: { header: "X-Request-ID" },',
				"ROUTA_CORRELATION_HEADER_CONFLICT",
				'The correlation header "X-Request-ID" in src/routa.ts names x-request-id, which carries the request identity Routa generates.',
			],
			[
				'\tcorrelation: { header: "Authorization" },',
				"ROUTA_CORRELATION_HEADER_CONFLICT",
				'The correlation header "Authorization" in src/routa.ts names authorization, which is a credential header.',
			],
			[
				'\tcorrelation: { header: "Cookie" },',
				"ROUTA_CORRELATION_HEADER_CONFLICT",
				'The correlation header "Cookie" in src/routa.ts names cookie, which is a credential header.',
			],
			[
				'\tcorrelation: { header: "content-type" },',
				"ROUTA_CORRELATION_HEADER_CONFLICT",
				'The correlation header "content-type" in src/routa.ts names content-type, which is a header Routa owns on every response.',
			],
			[
				'\tcorrelation: { header: "Allow" },',
				"ROUTA_CORRELATION_HEADER_CONFLICT",
				'The correlation header "Allow" in src/routa.ts names allow, which is a header Routa sets on automatic OPTIONS and 405 responses.',
			],
			[
				'\tcorrelation: { header: "Vary" },',
				"ROUTA_CORRELATION_HEADER_CONFLICT",
				'The correlation header "Vary" in src/routa.ts names vary, which is a header Routa sets on automatic OPTIONS responses.',
			],
			[
				'\tcorrelation: { header: "access-control-allow-methods" },',
				"ROUTA_CORRELATION_HEADER_CONFLICT",
				'The correlation header "access-control-allow-methods" in src/routa.ts names access-control-allow-methods, which is a header Routa sets on automatic OPTIONS responses.',
			],
			[
				'\tcorrelation: { header: "Sunset" },',
				"ROUTA_CORRELATION_HEADER_CONFLICT",
				'The correlation header "Sunset" in src/routa.ts names sunset, which is a lifecycle header Routa emits.',
			],
			[
				'\tcorrelation: { header: "deprecation" },',
				"ROUTA_CORRELATION_HEADER_CONFLICT",
				'The correlation header "deprecation" in src/routa.ts names deprecation, which is a lifecycle header Routa emits.',
			],
			[
				'\tcorrelation: { header: "link" },',
				"ROUTA_CORRELATION_HEADER_CONFLICT",
				'The correlation header "link" in src/routa.ts names link, which is a lifecycle header Routa emits.',
			],
			[
				'\tcorrelation: { header: "WWW-Authenticate" },',
				"ROUTA_CORRELATION_HEADER_CONFLICT",
				'The correlation header "WWW-Authenticate" in src/routa.ts names www-authenticate, which carries Routa\'s authentication challenges.',
			],
		] as const) {
			expect(diagnostics({ "src/routa.ts": config(members) }), members).toEqual([
				{ code, message },
			]);
		}
	});

	it("LOG-AC-09 rejects a correlation header that a declared credential scheme reads, in any case, without running src/routa.ts", () => {
		const sentinel = join(mkdtempSync(join(tmpdir(), "routa-credential-sentinel-")), "executed");
		const cases = [
			[
				"x-api-key",
				'The correlation header "x-api-key" in src/routa.ts names x-api-key, which the apiKey scheme "serviceKey" reads its credential from.',
			],
			[
				"X-API-KEY",
				'The correlation header "X-API-KEY" in src/routa.ts names x-api-key, which the apiKey scheme "serviceKey" reads its credential from.',
			],
			[
				"x-client-cert",
				'The correlation header "x-client-cert" in src/routa.ts names x-client-cert, which the custom scheme "clientCert" reads its credential from.',
			],
			[
				"X-Client-CERT",
				'The correlation header "X-Client-CERT" in src/routa.ts names x-client-cert, which the custom scheme "clientCert" reads its credential from.',
			],
			[
				"AUTHORIZATION",
				'The correlation header "AUTHORIZATION" in src/routa.ts names authorization, which is a credential header.',
			],
			[
				"Cookie",
				'The correlation header "Cookie" in src/routa.ts names cookie, which is a credential header.',
			],
		] as const;

		for (const [header, message] of cases) {
			expect(diagnostics({ "src/routa.ts": credentialConfig(header, sentinel) }), header).toEqual([
				{ code: "ROUTA_CORRELATION_HEADER_CONFLICT", message },
			]);
		}

		expect(diagnostics({ "src/routa.ts": credentialConfig("x-trace-ref", sentinel) })).toEqual([]);
		expect(existsSync(sentinel)).toBe(false);
	});

	it("LOG-AC-09 leaves a credential header it cannot read to the authentication diagnostic", () => {
		const routa = credentialConfig("x-api-key", "unused").replace(
			'header: "X-Api-Key"',
			"header: process.env.API_KEY_HEADER!",
		);

		expect(diagnostics({ "src/routa.ts": routa }).map((item) => item.code)).toEqual([
			"ROUTA_AUTH_CONFIG_UNRESOLVED",
		]);
	});

	it("LOG-AC-11 reads correlation behind a named default export and a string-literal computed key", () => {
		for (const [routa, header] of [
			[
				`import { createRouta } from "@routa-ts/core";\nconst config = createRouta({ correlation: { header: "X-Trace-Ref" } });\nexport { config as default };\n`,
				"x-trace-ref",
			],
			[config('\t["correlation"]: true,'), "x-correlation-id"],
		] as const) {
			const result = validateProject(
				project({ "src/routa.ts": routa, "src/routes/status/route.ts": statusRoute }),
				{ write: false },
			);
			expect(result.diagnostics, routa).toEqual([]);
			expect(result.warnings, routa).toEqual([]);
			expect(result.correlationHeader, routa).toBe(header);
		}

		expect(
			diagnostics({
				"src/routa.ts": config('\t["correlation"]: { header: process.env.CORR ?? "x-trace" },'),
			}),
		).toEqual([
			{
				code: "ROUTA_CORRELATION_CONFIG_UNRESOLVED",
				message: "The correlation config in src/routa.ts cannot be statically read.",
			},
		]);
	});

	it("LOG-AC-11 reads correlation in a default re-exported or imported from another module", () => {
		const reexports = [
			'export { default } from "./config.js";\n',
			'export { config as default } from "./config.js";\n',
			'import config from "./config.js";\nexport default config;\n',
		];
		const configModule = (members: string) =>
			`import { createRouta } from "@routa-ts/core";\nexport const config = createRouta({ ${members} });\nexport default config;\n`;

		for (const routa of reexports) {
			for (const [members, header] of [
				["port: 3000", undefined],
				['correlation: { header: "X-Trace-Ref" }', "x-trace-ref"],
			] as const) {
				const result = validateProject(
					project({
						"src/routa.ts": routa,
						"src/config.ts": configModule(members),
						"src/routes/status/route.ts": statusRoute,
					}),
					{ write: false },
				);
				expect(result.diagnostics, `${routa} ${members}`).toEqual([]);
				expect(result.warnings, `${routa} ${members}`).toEqual([]);
				expect(result.correlationHeader, `${routa} ${members}`).toBe(header);
			}

			const cwd = project({
				"src/routa.ts": routa,
				"src/config.ts": configModule(
					'correlation: { header: process.env.CORRELATION_HEADER ?? "x-trace" }',
				),
				"src/routes/status/route.ts": statusRoute,
			});
			expect(
				validateProject(cwd, { write: false }).diagnostics.map(({ code, file, message }) => ({
					code,
					file,
					message,
				})),
				routa,
			).toEqual([
				{
					code: "ROUTA_CORRELATION_CONFIG_UNRESOLVED",
					file: "src/config.ts",
					message: "The correlation config in src/routa.ts cannot be statically read.",
				},
			]);
		}
	});

	it("LOG-AC-11 reads correlation in createRouta imported under another name or as a namespace", () => {
		const aliased = 'import { createRouta as defineApi } from "@routa-ts/core";\n';
		const namespace = 'import * as routa from "@routa-ts/core";\n';

		for (const [routa, header] of [
			[`${aliased}export default defineApi({ port: 3000 });\n`, undefined],
			[`${aliased}export default defineApi({ correlation: true });\n`, "x-correlation-id"],
			[
				`${aliased}const shared = defineApi({ correlation: { header: "X-Trace-Ref" } });\nexport default defineApi({ port: 3000, ...shared });\n`,
				"x-trace-ref",
			],
			[`${namespace}export default routa.createRouta({ port: 3000 });\n`, undefined],
			[
				`${namespace}export default routa.createRouta({ correlation: { header: "X-Trace-Ref" } });\n`,
				"x-trace-ref",
			],
		] as const) {
			const result = validateProject(
				project({ "src/routa.ts": routa, "src/routes/status/route.ts": statusRoute }),
				{ write: false },
			);
			expect(result.diagnostics, routa).toEqual([]);
			expect(result.warnings, routa).toEqual([]);
			expect(result.correlationHeader, routa).toBe(header);
		}
	});

	it("LOG-AC-11 reads correlation in a createRouta that a local module re-exports from @routa-ts/core", async () => {
		const reexport = 'export { createRouta } from "@routa-ts/core";\n';
		const local = 'import { createRouta } from "./config-helpers.js";\n';

		for (const [helpers, routa, header] of [
			[reexport, `${local}export default createRouta({ port: 3000 });\n`, undefined],
			[
				reexport,
				`${local}export default createRouta({ correlation: { header: "X-Trace-Ref" } });\n`,
				"x-trace-ref",
			],
			[
				reexport,
				`${local}const shared = createRouta({ correlation: true });\nexport default createRouta({ port: 3000, ...shared });\n`,
				"x-correlation-id",
			],
			[
				'export { createRouta as defineApi } from "@routa-ts/core";\n',
				'import { defineApi } from "./config-helpers.js";\nexport default defineApi({ correlation: true });\n',
				"x-correlation-id",
			],
			[
				'export * from "@routa-ts/core";\n',
				'import * as helpers from "./config-helpers.js";\nexport default helpers.createRouta({ correlation: true });\n',
				"x-correlation-id",
			],
		] as const) {
			const cwd = project({
				"src/config-helpers.ts": helpers,
				"src/routa.ts": routa,
				"src/routes/status/route.ts": statusRoute,
			});
			const result = validateProject(cwd, { write: false });

			expect(result.diagnostics, routa).toEqual([]);
			expect(result.warnings, routa).toEqual([]);
			expect(result.correlationHeader, routa).toBe(header);

			const generate = await run(["generate"], { cwd });
			expect(generate.stderr ?? "", routa).toBe("");
			expect(generate.code, routa).toBe(0);
		}

		// A local module that re-exports an application function named createRouta does not make
		// it Routa's: its result is still read by its type, which may hold correlation.
		const opaque = validateProject(
			project({
				"src/factory.ts":
					'import type { RoutaConfig } from "@routa-ts/core";\nexport function createRouta(config: object): RoutaConfig {\n\treturn { ...config, correlation: { header: "x-other" } };\n}\n',
				"src/config-helpers.ts": 'export { createRouta } from "./factory.js";\n',
				"src/routa.ts": `${local}export default createRouta({ correlation: true });\n`,
				"src/routes/status/route.ts": statusRoute,
			}),
			{ write: false },
		);
		expect(opaque.diagnostics.map(({ code, file }) => ({ code, file }))).toEqual([
			{ code: "ROUTA_CORRELATION_CONFIG_UNRESOLVED", file: "src/routa.ts" },
		]);
	});

	it("LOG-AC-11 reads a function named createRouta from another module by its type, not its argument", () => {
		const routa =
			'import { createRouta } from "./factory.js";\nexport default createRouta({ correlation: true });\n';
		const result = (factory: string) =>
			validateProject(
				project({
					"src/routa.ts": routa,
					"src/factory.ts": factory,
					"src/routes/status/route.ts": statusRoute,
				}),
				{ write: false },
			);

		// Its result may hold correlation, which Routa cannot read.
		expect(
			result(
				'import type { RoutaConfig } from "@routa-ts/core";\nexport function createRouta(config: object): RoutaConfig {\n\treturn { ...config, correlation: { header: "x-other" } };\n}\n',
			).diagnostics.map(({ code, file }) => ({ code, file })),
		).toEqual([{ code: "ROUTA_CORRELATION_CONFIG_UNRESOLVED", file: "src/routa.ts" }]);

		// Its result has no correlation, whatever its argument holds.
		const opaque = result(
			"export function createRouta(_config: object): { port: number } {\n\treturn { port: 3000 };\n}\n",
		);
		expect(opaque.diagnostics).toEqual([]);
		expect(opaque.correlationHeader).toBeUndefined();
	});

	it("LOG-AC-11 rejects a spread, key, argument, or export whose type may hold correlation", () => {
		const unresolved = {
			code: "ROUTA_CORRELATION_CONFIG_UNRESOLVED",
			message:
				"The createRouta config in src/routa.ts has a spread, computed key, config argument, or default export whose type may hold correlation, so routa generate cannot read the correlation header.",
		};

		for (const routa of [
			// The visible member comes first, so the spread decides correlation at runtime.
			config(
				"\tcorrelation: true,\n\t...deploymentOverrides(),",
				"const deploymentOverrides = (): { port?: number; correlation?: boolean } => ({});\n",
			),
			config(
				"\tcorrelation: true,\n\t...overrides,",
				"declare const overrides: { correlation: false };\n",
			),
			config("\t...settings,", "declare const settings: any;\n"),
			config("\t...settings,", "declare const settings: Record<string, unknown>;\n"),
			config("\t...settings,", 'declare const settings: Record<"correlation", boolean>;\n'),
			config(
				"\t...(settings as object | { correlation: true }),",
				"declare const settings: object;\n",
			),
			config("\t[key]: true,", "declare const key: string;\n"),
			`import { createRouta, type RoutaConfig } from "@routa-ts/core";\ndeclare const settings: RoutaConfig & { correlation: true };\nexport default createRouta(settings);\n`,
			// Routa's own RoutaConfig may hold correlation, so a value of that type may set it.
			config(
				"\tcorrelation: true,\n\t...deployment(),",
				'import type { RoutaConfig } from "@routa-ts/core";\nconst deployment = (): RoutaConfig => ({ correlation: { header: "x-trace-ref" } });\n',
			),
			`import { createRouta, type RoutaConfig } from "@routa-ts/core";\ndeclare const settings: RoutaConfig;\nexport default createRouta(settings);\n`,
			config(
				"\t...base,",
				'import type { RoutaConfig } from "@routa-ts/core";\ndeclare const base: Partial<RoutaConfig>;\n',
			),
			`import type { RoutaConfig } from "@routa-ts/core";\ndeclare function load(): RoutaConfig;\nexport default load();\n`,
		]) {
			expect(diagnostics({ "src/routa.ts": routa }), routa).toEqual([unresolved]);
		}

		// Behind an imported createRouta call, the value is reported where it is written.
		const cwd = project({
			"src/routa.ts": config("\t...shared,", 'import { shared } from "./shared.js";\n'),
			"src/shared.ts": `import { createRouta, type RoutaConfig } from "@routa-ts/core";\ndeclare function load(): RoutaConfig;\nexport const shared = createRouta(load());\n`,
			"src/routes/status/route.ts": statusRoute,
		});
		expect(
			validateProject(cwd, { write: false }).diagnostics.map(({ code, file }) => ({ code, file })),
		).toEqual([{ code: unresolved.code, file: "src/shared.ts" }]);
	});

	it("LOG-AC-11 reads correlation past a spread or key whose type has no correlation", () => {
		const sharedModule = (members: string) =>
			`import { createRouta } from "@routa-ts/core";\nexport const shared = createRouta({ ${members} });\n`;

		const cases: Array<[string, string | undefined, Record<string, string>?]> = [
			[
				config(
					"\tcorrelation: true,\n\t...deployment(),",
					'const deployment = () => ({ host: process.env.HOST ?? "127.0.0.1", port: 3000 });\n',
				),
				"x-correlation-id",
			],
			[config("\t...settings(),", "const settings = () => ({});\n"), undefined],
			[
				config(
					'\tcorrelation: { header: "x-trace-ref" },\n\t[key]: 4000,',
					'const key: "port" = "port";\n',
				),
				"x-trace-ref",
			],
			[
				`import { createRouta } from "@routa-ts/core";\nconst listen = (): { port: number } => ({ port: 3000 });\nexport default createRouta(listen());\n`,
				undefined,
			],
			// A createRouta call or object literal behind a spread or argument is read in place.
			[
				config(
					"\tcorrelation: true,\n\t...shared,",
					"const shared = createRouta({ port: 3000 });\n",
				),
				"x-correlation-id",
			],
			[
				config(
					"\t...shared,",
					'const shared = createRouta({ correlation: { header: "x-trace-ref" } });\n',
				),
				"x-trace-ref",
			],
			[
				`import { createRouta } from "@routa-ts/core";\nconst shared = createRouta({ port: 3000 });\nexport default createRouta(shared);\n`,
				undefined,
			],
			[
				config("\t...shared,", 'import { shared } from "./shared.js";\n'),
				"x-correlation-id",
				{ "src/shared.ts": sharedModule("correlation: true") },
			],
			[
				`import { createRouta } from "@routa-ts/core";\nimport { shared } from "./shared.js";\nexport default createRouta(shared);\n`,
				undefined,
				{ "src/shared.ts": sharedModule("port: 3000") },
			],
		];

		for (const [routa, header, files = {}] of cases) {
			const result = validateProject(
				project({ "src/routa.ts": routa, "src/routes/status/route.ts": statusRoute, ...files }),
				{ write: false },
			);
			expect(result.diagnostics, routa).toEqual([]);
			expect(
				result.warnings.filter((warning) => warning.code.startsWith("ROUTA_CORRELATION")),
				routa,
			).toEqual([]);
			expect(result.correlationHeader, routa).toBe(header);
		}
	});
});

describe("reserved identity in route contracts", () => {
	const middleware = (body: string) => `import { createMiddleware } from "@routa-ts/core";
import { z } from "zod";

export const withIdentity = createMiddleware({
${body}
});
`;

	it("LOG-AC-10 rejects middleware that provides or passes on the identity or the logger", () => {
		for (const [body, message] of [
			[
				'\tprovides: { requestId: z.string() },\n\trun: ({ next }) => next({ requestId: "r" }),',
				"Middleware withIdentity provides ctx.requestId, which Routa reserves for the request identity it generates.",
			],
			[
				"\tprovides: { correlationId: z.string() },",
				"Middleware withIdentity provides ctx.correlationId, which Routa reserves for the correlation ID it accepts.",
			],
			[
				"\tprovides: { logger: z.string() },",
				"Middleware withIdentity provides ctx.logger, which Routa reserves for the request logger.",
			],
			[
				'\trun: ({ next }) => next({ requestId: "forged" }),',
				"Middleware withIdentity passes ctx.requestId to next(), which Routa reserves for the request identity it generates.",
			],
		] as const) {
			expect(
				diagnostics({ "src/routes/middleware.ts": middleware(body) }).filter(
					(item) => item.code === "ROUTA_CONTEXT_RESERVED",
				)[0],
				body,
			).toEqual({ code: "ROUTA_CONTEXT_RESERVED", message });
		}
	});

	it("LOG-AC-10 rejects outcomes and rejects that declare x-request-id or the correlation header", () => {
		const route = (
			header: string,
		) => `import { createMiddleware, createRoute, createRouteRoot } from "@routa-ts/core";
import { z } from "zod";

const gate = createMiddleware({
\trejects: { denied: { status: 403, headers: z.object({ "${header}": z.string().optional() }) } },
\trun: ({ next }) => next(),
});

export default createRouteRoot("/status")({
\tget: createRoute({
\t\tmiddleware: [gate],
\t\tresponses: { ok: { status: 200, headers: z.object({ "${header}": z.string() }) } },
\t\trun: () => ({ type: "ok", headers: { "${header}": "x" } }),
\t}),
});
`;

		expect(diagnostics({ "src/routes/status/route.ts": route("x-request-id") })).toEqual([
			{
				code: "ROUTA_RESPONSE_HEADER_RESERVED",
				message:
					'Response header "x-request-id" is reserved: Routa owns x-request-id: z.object({ "x-request-id": z.string() })',
			},
			{
				code: "ROUTA_RESPONSE_HEADER_RESERVED",
				message:
					'Response header "x-request-id" is reserved: Routa owns x-request-id: z.object({ "x-request-id": z.string().optional() })',
			},
		]);
		const correlated = {
			"src/routa.ts": config('\tcorrelation: { header: "X-Trace-Ref" },'),
			"src/routes/status/route.ts": route("x-trace-ref"),
		};
		expect(diagnostics(correlated).map((item) => item.message)).toEqual([
			'Response header "x-trace-ref" is reserved: Routa echoes the correlation ID in x-trace-ref: z.object({ "x-trace-ref": z.string() })',
			'Response header "x-trace-ref" is reserved: Routa echoes the correlation ID in x-trace-ref: z.object({ "x-trace-ref": z.string().optional() })',
		]);
		expect(diagnostics({ "src/routes/status/route.ts": route("x-trace-ref") })).toEqual([]);
	});
});

type OpenApiOperation = {
	deprecated?: boolean;
	"x-routa-sunset"?: string;
	"x-routa-replacement"?: string;
	responses: Record<string, { headers?: Record<string, unknown> }>;
};

type OpenApi = {
	paths: Record<
		string,
		Record<string, { responses: Record<string, { headers?: Record<string, unknown> }> }>
	>;
};

/** A Routa project whose TypeScript resolves `@routa-ts/core` to this checkout's source. */
function project(files: Record<string, string>): string {
	const cwd = mkdtempSync(join(tmpdir(), "routa-identity-"));
	mkdirSync(join(cwd, "node_modules/@routa-ts"), { recursive: true });
	symlinkSync(join(repoRoot, "packages/core"), join(cwd, "node_modules/@routa-ts/core"), "dir");
	symlinkSync(
		join(repoRoot, "packages/core/node_modules/zod"),
		join(cwd, "node_modules/zod"),
		"dir",
	);
	const allFiles: Record<string, string> = {
		"package.json": JSON.stringify({ type: "module" }),
		"tsconfig.json": JSON.stringify({
			compilerOptions: {
				target: "ES2022",
				module: "NodeNext",
				moduleResolution: "NodeNext",
				strict: true,
				skipLibCheck: true,
				noEmit: true,
				paths: {
					"@routa-ts/core": [join(repoRoot, "packages/core/src/index.ts")],
					"@routa-ts/core/hono": [join(repoRoot, "packages/core/src/hono.ts")],
					"@routa-ts/core/testing": [join(repoRoot, "packages/core/src/testing.ts")],
					zod: [join(repoRoot, "packages/core/node_modules/zod/index.d.ts")],
				},
			},
			include: ["src/**/*.ts", ".routa/**/*.ts"],
		}),
		...files,
	};

	for (const [file, content] of Object.entries(allFiles)) {
		mkdirSync(dirname(join(cwd, file)), { recursive: true });
		writeFileSync(join(cwd, file), content);
	}

	return cwd;
}

function diagnostics(files: Record<string, string>): Array<{ code: string; message: string }> {
	return validateProject(
		project({ "src/routa.ts": config(""), "src/routes/status/route.ts": statusRoute, ...files }),
		{ write: false },
	).diagnostics.map(({ code, message }) => ({ code, message }));
}
