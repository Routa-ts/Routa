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
		] as const) {
			expect(diagnostics({ "src/routa.ts": config(members) }), members).toEqual([
				{ code, message },
			]);
		}
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

	it("LOG-AC-09 warns when a spread or default export it cannot read may hold correlation", () => {
		for (const routa of [
			config("\t...settings(),", "const settings = () => ({});\n"),
			'export { default } from "./config.js";\n',
		]) {
			const result = validateProject(
				project({
					"src/routa.ts": routa,
					"src/config.ts": config("\tcorrelation: true,"),
					"src/routes/status/route.ts": statusRoute,
				}),
				{ write: false },
			);

			expect(
				result.warnings.map((warning) => warning.code),
				routa,
			).toContain("ROUTA_CORRELATION_SPREAD_UNRESOLVED");
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
