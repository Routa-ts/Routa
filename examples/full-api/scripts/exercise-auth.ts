/**
 * Sends the authentication credential matrix through the generated test application and asserts
 * each response: status, problem type, selected scheme, WWW-Authenticate, and which
 * authenticators ran. Every credential here is a demonstration value, unfit for production.
 *
 * Usage: pnpm auth:exercise
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

// Before the application loads: src/session.ts reads the secret once, at import.
process.env.ROUTA_DEMO_SESSION_SECRET = "exercise-only-secret";
process.env.ROUTA_DEMO_LOGGER = "off";

const { createTestApp } = await import("../.routa/testing.gen.js");
const { appServices } = await import("../src/services.js");

type Scheme = "session" | "accountToken" | "serviceKey" | "clientCert";

// Each authenticator makes exactly one directory call, so counting calls counts authenticators.
const calls = new Map<Scheme, number>();
const count = <T>(scheme: Scheme, result: T): T => {
	calls.set(scheme, (calls.get(scheme) ?? 0) + 1);
	return result;
};

const app = await createTestApp(async (context) => {
	const services = await appServices(context);
	const { identities } = services;

	return {
		...services,
		identities: {
			accountForSession: (token) => count("session", identities.accountForSession(token)),
			accountForToken: (token) => count("accountToken", identities.accountForToken(token)),
			serviceForKey: (key) => count("serviceKey", identities.serviceForKey(key)),
			serviceForCertificate: (certificate) =>
				count("clientCert", identities.serviceForCertificate(certificate)),
		},
	};
});

const sign = (userId: string) =>
	`demo-user:${userId}.${createHmac("sha256", "exercise-only-secret").update(userId).digest("base64url")}`;

const credentials = {
	writerSession: { cookie: `session=${sign("acme:writer")}` },
	adminSession: { cookie: `session=${sign("admin")}` },
	staleSession: { cookie: "session=expired" },
	adminToken: { authorization: "Bearer demo-token-admin" },
	writerToken: { authorization: "Bearer demo-token-acme-writer" },
	wrongToken: { authorization: "Bearer not-a-demo-token" },
	serviceKey: { "x-api-key": "demo-key-acme-sync" },
	wrongKey: { "x-api-key": "not-a-demo-key" },
	clientCert: {
		"x-client-cert": encodeURIComponent(
			readFileSync(new URL("demo-client-cert.pem", import.meta.url), "utf8"),
		),
	},
	malformedCert: { "x-client-cert": "not-a-certificate" },
};

const problem = (name: string) => `https://routa-ts.dev/problems/${name}`;
/** The complete problem body each framework outcome sends: nothing about the credential. */
const problemBodies: Record<string, unknown> = {
	[problem("authentication-required")]: {
		type: problem("authentication-required"),
		title: "Authentication required",
		status: 401,
	},
	[problem("authentication-failed")]: {
		type: problem("authentication-failed"),
		title: "Authentication failed",
		status: 401,
	},
	[problem("ambiguous-credentials")]: {
		type: problem("ambiguous-credentials"),
		title: "Ambiguous credentials",
		status: 400,
	},
};
const allChallenges = 'Bearer realm="full-api", Session, ApiKey, clientCert';
const tenantChallenges = "Session, ApiKey";

type Case = {
	name: string;
	method?: string;
	path: string;
	headers?: Record<string, string>;
	body?: unknown;
	status: number;
	/** The problem `type` the body carries, for framework outcomes. */
	problem?: string;
	/** The `scheme` GET /whoami reports. */
	scheme?: Scheme;
	/** The principal GET /whoami reports with `scheme`. */
	principal?: { type: "account" | "service"; id: string };
	challenge?: string;
	/** How many times each authenticator ran; omitted schemes ran zero times. */
	ran: Partial<Record<Scheme, number>>;
};

const cases: Case[] = [
	// Missing credentials.
	{ name: "public, no credential", path: "/whoami", status: 200, ran: {} },
	{
		name: "protected, no credential",
		path: "/admin/audit-events",
		status: 401,
		problem: problem("authentication-required"),
		challenge: allChallenges,
		ran: {},
	},
	{
		name: "tenant area, no credential",
		path: "/tenants/acme/projects",
		status: 401,
		problem: problem("authentication-required"),
		challenge: tenantChallenges,
		ran: {},
	},
	// One valid credential of each scheme on a public route.
	{
		name: "public, valid session",
		path: "/whoami",
		headers: credentials.writerSession,
		status: 200,
		scheme: "session",
		principal: { type: "account", id: "acme:writer" },
		ran: { session: 1 },
	},
	{
		name: "public, valid Bearer token",
		path: "/whoami",
		headers: credentials.adminToken,
		status: 200,
		scheme: "accountToken",
		principal: { type: "account", id: "admin" },
		ran: { accountToken: 1 },
	},
	{
		name: "public, valid API key",
		path: "/whoami",
		headers: credentials.serviceKey,
		status: 200,
		scheme: "serviceKey",
		principal: { type: "service", id: "acme:sync" },
		ran: { serviceKey: 1 },
	},
	{
		name: "public, valid client certificate (custom)",
		path: "/whoami",
		headers: credentials.clientCert,
		status: 200,
		scheme: "clientCert",
		principal: { type: "service", id: "reports" },
		ran: { clientCert: 1 },
	},
	// Invalid credentials fail closed, even on a public route, and challenge only their scheme.
	{
		name: "public, invalid session",
		path: "/whoami",
		headers: credentials.staleSession,
		status: 401,
		problem: problem("authentication-failed"),
		challenge: "Session",
		ran: { session: 1 },
	},
	{
		name: "public, invalid Bearer token",
		path: "/whoami",
		headers: credentials.wrongToken,
		status: 401,
		problem: problem("authentication-failed"),
		challenge: 'Bearer realm="full-api", error="invalid_token"',
		ran: { accountToken: 1 },
	},
	{
		name: "public, invalid API key",
		path: "/whoami",
		headers: credentials.wrongKey,
		status: 401,
		problem: problem("authentication-failed"),
		challenge: "ApiKey",
		ran: { serviceKey: 1 },
	},
	{
		name: "public, malformed certificate (extract rejects it)",
		path: "/whoami",
		headers: credentials.malformedCert,
		status: 401,
		problem: problem("authentication-failed"),
		challenge: "clientCert",
		ran: {},
	},
	// Inherited requirements and the nested API-key-or-session restriction.
	{
		name: "tenant area, valid session",
		path: "/tenants/acme/projects",
		headers: credentials.writerSession,
		status: 200,
		ran: { session: 1 },
	},
	{
		name: "tenant area, valid API key",
		path: "/tenants/acme/projects",
		headers: credentials.serviceKey,
		status: 200,
		ran: { serviceKey: 1 },
	},
	{
		name: "tenant area, write with a writer's session",
		method: "POST",
		path: "/tenants/acme/projects",
		headers: { ...credentials.writerSession, "content-type": "application/json" },
		body: { name: "Launch" },
		status: 201,
		ran: { session: 1 },
	},
	{
		name: "tenant area, disallowed Bearer token",
		path: "/tenants/acme/projects",
		headers: credentials.writerToken,
		status: 401,
		problem: problem("authentication-failed"),
		challenge: tenantChallenges,
		ran: {},
	},
	{
		name: "tenant area, disallowed Bearer token beside a session",
		path: "/tenants/acme/projects",
		headers: { ...credentials.writerToken, ...credentials.writerSession },
		status: 200,
		ran: { session: 1 },
	},
	// Strict mode: two allowed credentials answer 400 before any authenticator runs.
	{
		name: "tenant area, session and API key",
		path: "/tenants/acme/projects",
		headers: { ...credentials.writerSession, ...credentials.serviceKey },
		status: 400,
		problem: problem("ambiguous-credentials"),
		ran: {},
	},
	{
		name: "public, Bearer token and session",
		path: "/whoami",
		headers: { ...credentials.adminToken, ...credentials.adminSession },
		status: 400,
		problem: problem("ambiguous-credentials"),
		ran: {},
	},
	// Method-level Bearer-only requirement under the inherited one.
	{
		name: "reports, valid Bearer token",
		path: "/admin/reports",
		headers: credentials.adminToken,
		status: 200,
		ran: { accountToken: 1 },
	},
	{
		name: "reports, no credential",
		path: "/admin/reports",
		status: 401,
		problem: problem("authentication-required"),
		challenge: 'Bearer realm="full-api"',
		ran: {},
	},
	{
		name: "reports, disallowed session",
		path: "/admin/reports",
		headers: credentials.adminSession,
		status: 401,
		problem: problem("authentication-failed"),
		challenge: 'Bearer realm="full-api"',
		ran: {},
	},
	// Authentication is not authorization: the certificate authenticates, the app denies it.
	{
		name: "admin, valid certificate for a non-admin service",
		path: "/admin/audit-events",
		headers: credentials.clientCert,
		status: 403,
		ran: { clientCert: 1 },
	},
	// Sign-in runs under automatic authentication. A stale cookie fails before the handler.
	{
		name: "sign-in, clean request",
		method: "POST",
		path: "/auth/session",
		headers: { "content-type": "application/json" },
		body: { token: sign("acme:writer") },
		status: 200,
		ran: {},
	},
	{
		name: "sign-in with a stale session cookie (known limit)",
		method: "POST",
		path: "/auth/session",
		headers: { ...credentials.staleSession, "content-type": "application/json" },
		body: { token: sign("acme:writer") },
		status: 401,
		problem: problem("authentication-failed"),
		challenge: "Session",
		ran: { session: 1 },
	},
];

let failures = 0;

for (const testCase of cases) {
	calls.clear();
	const response = await app.request(testCase.path, {
		method: testCase.method ?? "GET",
		headers: testCase.headers ?? {},
		...(testCase.body === undefined ? {} : { body: JSON.stringify(testCase.body) }),
	});
	const text = await response.text();
	const body = text
		? (JSON.parse(text) as { type?: string; status?: string; scheme?: string })
		: undefined;
	const ran = Object.fromEntries(calls);
	const challenge = response.headers.get("www-authenticate") ?? undefined;

	try {
		assert.equal(response.status, testCase.status, "status");
		assert.equal(challenge, testCase.challenge, "www-authenticate");
		assert.deepEqual(ran, testCase.ran, "authenticators run");

		if (testCase.problem) {
			assert.deepEqual(body, problemBodies[testCase.problem], "problem body");
		}

		if (testCase.path === "/whoami" && testCase.status === 200) {
			assert.deepEqual(
				body,
				testCase.scheme
					? { status: "authenticated", scheme: testCase.scheme, principal: testCase.principal }
					: { status: "anonymous" },
				"ctx.auth",
			);
		}

		const detail = [
			testCase.problem?.replace("https://routa-ts.dev/problems/", ""),
			body?.scheme && `scheme=${body.scheme}`,
			challenge && `challenge=${challenge}`,
			`ran=${JSON.stringify(ran)}`,
		].filter(Boolean);
		console.log(`ok   ${response.status} ${testCase.name}: ${detail.join(" ")}`);
	} catch (error) {
		failures += 1;
		console.error(`FAIL ${response.status} ${testCase.name}: ${(error as Error).message}`);
		console.error(`     body=${text} challenge=${challenge} ran=${JSON.stringify(ran)}`);
	}
}

await app.dispose();

if (failures > 0) {
	console.error(`${failures} of ${cases.length} authentication cases failed.`);
	process.exit(1);
}

console.log(`All ${cases.length} authentication cases passed.`);
