# Security Design (Group 2)

## Scope

This document records decisions for Group 2 in small parts.

## Security Pipeline Terminology

Trail has one request execution pipeline: middleware.

- Middleware runs during request handling, can enrich typed `ctx.state`, can reject early, and can contribute documented responses.
- A guard is middleware whose primary purpose is enforcement, such as `requireAuth`, `requirePermission`, or tenant access checks.
- A hook is a developer-provided callback invoked by framework-controlled middleware, auth providers, or lifecycle components. Hooks do not directly replace middleware ordering, typed state guarantees, reject declarations, or OpenAPI contribution.
- A guardrail is a framework diagnostic, not request middleware. Guardrails warn by default when configuration or route declarations create security risk, and projects may configure guardrails to fail startup/build/check steps by severity or rule id.

Initial guardrail implementation can live in Trail's own config and route analysis step. Integration with external linters or custom lint rules is optional and should be evaluated during implementation planning.

## Part 2.1: Authentication Modes and Middleware Model

### Decisions

- Trail supports multiple authentication modes:
  - Bearer token
  - API key
  - Session/cookie
- Each mode is optional and can be enabled independently.
- Trail uses a two-layer authentication flow:
  1. Global auth-resolution middleware detects presented credentials, selects one credential by configured priority, validates the selected credential, and attaches normalized `ctx.state.auth`.
  2. Route-level `requireAuth` middleware enforces authenticated auth context and guarantees `ctx.state.auth.status === "authenticated"` for later middleware and handlers.
- On routes that do not require authentication, invalid provided credentials still fail the request (`401 Unauthorized`) instead of silently downgrading to anonymous.

## Part 2.2: Auth Provider Model

### Decisions

- Trail supports two auth provider modes:
  - `better-auth`: Trail provides a configurable first-party integration powered by Better Auth.
  - `custom`: application defines its own auth structure against Trail's provider contract.
- Trail defines a stable auth provider contract so framework middleware behavior remains consistent across providers.
- Better Auth integration is the default scaffolded implementation path, not a hard lock-in.
- In Better Auth mode, Trail may use Better Auth support/plugins for session/cookie, bearer token, and API key authentication where selected by the developer.
- Trail should provide an auth setup generator command (`npx trail auth`) to scaffold provider selection, auth mode choices, and middleware wiring.

### Provider Contract (high level)

- Resolve identity from request.
- Validate configured credential types.
- Expose auth context to middleware and handlers.
- Integrate with authorization policy checks.

### Custom Provider Direction

- Trail provides a first-party Better Auth integration as the default scaffolded implementation path.
- Trail's framework contract remains provider-neutral.
- Better Auth and custom providers both plug into Trail's standard auth-resolution middleware.
- Custom auth should normally be implemented through Trail's auth provider and credential strategy interfaces, not by replacing the auth pipeline with ad hoc middleware.
- Credential strategies should cover enabled auth modes such as bearer token, API key, and session/cookie.
- Trail's auth-resolution middleware owns credential detection, priority selection, validation of the selected credential, normalized `ctx.state.auth`, standard auth errors, and security events.
- Developers may still write custom auth middleware as an escape hatch, but this is not the recommended path because it bypasses Trail's shared priority config, normalized auth context, standard error mapping, provider swap path, and future OpenAPI/security metadata integration.

### Credential Selection

- Trail uses a configurable credential priority model.
- Default priority is API-oriented: bearer token, API key, then session/cookie.
- If multiple credentials are present, Trail selects the first presented enabled credential by priority and validates only that credential.
- If the selected credential is invalid, Trail returns `401 Unauthorized` and does not fall back to lower-priority credentials.
- If no credential is present, Trail attaches anonymous auth context unless a later guard requires authentication.
- Projects may override credential priority in configuration.
- Projects may configure multiple presented credentials to reject instead of resolving by priority.
- Route-level auth configuration may narrow accepted credential schemes for a route or route group.

### Normalized Auth Context

- `ctx.state.auth` is the only Trail-standard auth context.
- Better Auth mode maps Better Auth `{ user, session }` results into `ctx.state.auth.user` and `ctx.state.auth.session`.
- Custom providers should return the same normalized structure.
- `requireAuth()` guarantees authenticated auth context for handlers and later middleware.
- Raw credential secrets, including session tokens and raw API key values, should not be exposed in `ctx.state.auth` by default.

```ts
type AuthContext<User = TrailAuthUser, Session = TrailAuthSession> =
	| { status: "anonymous" }
	| {
			status: "authenticated";
			provider: "better-auth" | string;
			scheme: "session" | "bearer" | "apiKey";
			principal: {
				id: string;
				type: "user" | "service" | "apiKey" | string;
				userId?: string;
			};
			user: User | null;
			session: Session | null;
			credential: {
				type: "session" | "bearer" | "apiKey";
				id?: string;
				expiresAt?: Date;
				metadata?: Record<string, unknown>;
			};
			roles?: string[];
			scopes?: string[];
			permissions?: string[];
	  };
```

Default Better Auth-inspired user/session shapes:

```ts
type TrailAuthUser = {
	id: string;
	name: string;
	email: string;
	emailVerified: boolean;
	image?: string | null;
	createdAt: Date;
	updatedAt: Date;
};

type TrailAuthSession = {
	id: string;
	userId: string;
	expiresAt: Date;
	ipAddress?: string | null;
	userAgent?: string | null;
	createdAt: Date;
	updatedAt: Date;
};
```

### Standard Auth Rejects

- `missingCredentials`: `401 Unauthorized`; required auth is missing.
- `invalidCredentials`: `401 Unauthorized`; selected credential is invalid, expired, revoked, malformed, or failed validation.
- `unsupportedAuthScheme`: `401 Unauthorized`; presented scheme is not enabled or not accepted by the route.
- `ambiguousCredentials`: `400 Bad Request`; only used when `multipleCredentials: "reject"` is configured and more than one credential scheme is presented.
- `insufficientPermissions`: `403 Forbidden`; authenticated actor lacks required function-level permission.
- `resourceAccessDenied`: `403 Forbidden`; authenticated actor fails object-level policy.
- Public auth failure responses should use neutral messages and stable codes. Sensitive details such as token expiration, revocation, disabled users, missing sessions, and raw validation causes belong in security events/logs, not public response bodies.

### Rationale

- Teams can move fast with a secure default while keeping freedom to adopt custom auth models.
- A stable contract prevents framework-level auth drift and keeps DX predictable.
- Provider/strategy integration preserves custom auth flexibility while keeping framework behavior consistent.
- A Better Auth-inspired context keeps the recommended path easy while preserving provider-neutral route and middleware behavior.

## Part 2.3: Authorization Levels

### Decisions

- Trail models authorization at three levels:
  - Function-level authorization: whether an actor may perform an operation.
  - Object-level authorization: whether an actor may perform an operation on a specific resource instance.
  - Field-level authorization: which declared response shape an actor may receive for an allowed resource.
- Function-level authorization uses guard middleware such as `requirePermission("users.create")`.
- Object-level authorization uses guard middleware such as `authorizeResource("users.read", { resource, policy })`.
- `authorizeResource` includes the action/permission check by default, so developers should not normally place `requirePermission("users.read")` immediately before `authorizeResource("users.read", ...)`.
- Trail should provide a guardrail warning for repetitive middleware chains where `requirePermission(action)` is immediately followed by `authorizeResource(action, ...)`; projects may escalate that warning to an error through guardrail configuration.
- A resource is the specific object, record, domain entity, or business target being protected.
- A policy is developer-owned business logic that decides whether the authenticated actor may perform the action against that resource.
- Resource loading should remain explicit and typed. The preferred pattern is to load the resource into `ctx.state` with middleware, then authorize it with `authorizeResource`.
- Field-level authorization is modeled through named response variants, not a manual `oneOf` success schema. Trail keeps runtime variants explicit and generates OpenAPI `oneOf` documentation automatically when same-status variants expose different schemas for the same media type.
- Trail does not provide a public `oneOf` route response helper in v1. Developers should model different successful shapes as named response variants. Other composition helpers remain available where they do not weaken the response variant model.

### Example

```ts
middleware: [
	requireAuth(),
	loadUserById(),
	authorizeResource("users.read", {
		resource: ({ ctx }) => ctx.state.targetUser,
		policy: ({ auth, resource }) =>
			auth.principal.id === resource.id || auth.roles.includes("admin"),
	}),
];
```

```ts
responses: {
	basicUser: [200, BasicUserSchema],
	adminUser: [200, AdminUserSchema],
	secureAdminUser: [200, SecureAdminUserSchema],
}
```

### Rationale

- Function-level, object-level, and field-level authorization answer different security questions and should stay conceptually separate.
- Combining the function-level check into `authorizeResource` avoids repetitive route declarations for object-protected routes.
- Named response variants preserve Trail's `{ type, data }` runtime model while still allowing OpenAPI to document a single `200` response with generated `oneOf`.


## Part 2.4: Rate Limiting and Request Protection

### Decisions

- Trail ships opinionated defaults, while allowing full developer overrides.
- Trail's public rate-limit API is framework-level, not Hono-specific.
- In the v1 Hono runtime adapter, Trail may implement rate limiting by composing a Hono-compatible rate limiter. The adapter must preserve Trail semantics.
- Global rate-limit config defines available infrastructure and defaults: store, default identity keys, and store outage behavior.
- Route or group config defines the actual rate-limit policy: `limit`, `window`, optional identity `keys`, and security profile.
- Developer-facing rate-limit keys are identity dimensions only:
  - `ip`
  - `auth`
- Trail always includes the normalized route id in the internal rate-limit bucket namespace. Developers do not configure `route` as a key because route scope is implied by where the rate limit is declared or inherited.
- A global default rate limit means each route gets that default policy; routes do not share one global bucket unless a later explicit shared-bucket feature is added.
- Default algorithm: token bucket.
- Default `429 Too Many Requests` behavior includes `Retry-After` and Trail standard error body/code.
- Default execution controls:
  - Global request timeout with per-route override.
  - Global concurrency cap with per-route override.
- Routes may declare a security profile:
  - `public`
  - `protected`
  - `sensitive`
- Security profiles classify route risk and influence defaults and guardrails.
- Default profile inference:
  - Routes with `requireAuth` or `authorizeResource` are `protected`.
  - Routes without auth guards are `public`.
  - `sensitive` is explicit and should be used for high-risk or expensive actions such as login, password reset, MFA verification, API key creation, billing changes, exports, and admin mutations.
- If limiter backend is unavailable, default behavior is profile-aware:
  - Fail open for public routes.
  - Fail closed for protected routes.
  - Fail closed for sensitive routes.
- Status behavior:
  - Limit exceeded returns `429 Too Many Requests`.
  - Limiter backend unavailable with fail-closed behavior returns `503 Service Unavailable`.

- Rate limiting storage is backend-agnostic through a store adapter contract (no Redis lock-in).
- Trail should provide first-party store adapters for local memory and Redis, and support custom adapters for other backends.
- In multi-instance deployments without a distributed store, Trail should emit a startup warning.
- Memory storage is allowed, especially for development, prototypes, or single-instance vertical deployments.
- Memory storage in production should be a guardrail warning by default, not an error. Projects may escalate it to an error through guardrail configuration.
- Sensitive routes using memory storage should emit a stronger guardrail warning by default.

### Rationale

- Strong defaults reduce insecure deployments.
- Override support preserves flexibility for product-specific traffic models.
- Hybrid outage mode balances security and availability during incidents.
- Keeping only `ip` and `auth` as public keys avoids accidental cross-route sharing while keeping route scoping automatic.
- The Hono adapter can reuse mature Hono-compatible middleware without exposing Hono-specific rate-limit APIs as Trail's public contract.


## Part 2.5: CORS, Security Headers, and HTTPS Posture

### Decisions

- Trail uses environment-aware defaults: lax for development speed, strict for production safety.
- Trail uses preset-first security configuration with explicit overrides for advanced users.
- Production defaults:
  - CORS deny-by-default with explicit origin allowlist.
  - No wildcard origins when credentials are enabled.
  - API-focused strict security headers preset enabled by default.
  - HTTPS required in production, with trusted proxy configuration support.
  - Guardrails to discourage sensitive data in URLs.
- Development defaults:
  - Permissive localhost-focused CORS preset for rapid startup.
  - HTTPS not required.
  - Relaxed/minimal API security headers preset.
  - Clear startup warning that development profile is not production-safe.
- All defaults are overrideable by explicit developer configuration.

### CORS

- CORS supports presets and explicit config:
  - `dev`: localhost-friendly development behavior.
  - `strict`: production deny-by-default behavior.
  - explicit `CorsConfig`.
- Development defaults are localhost-focused.
- Production defaults deny cross-origin requests unless origins are explicitly configured.
- Credentialed CORS requires explicit origins; wildcard origins with credentials are invalid and should trigger a guardrail.
- Allowed methods should be inferred from declared route methods. Trail should auto-handle preflight `OPTIONS` unless the user defines custom `OPTIONS`.
- Allowed headers should include common API headers by default, such as `content-type`, `authorization`, and `accept`, plus configured API key/auth headers. Applications may add more headers explicitly.
- Exposed headers should be explicit; Trail may expose framework-relevant headers such as `retry-after` when rate limiting is enabled.

### Security Headers

- Security headers support presets and explicit overrides:
  - `off`
  - `api-dev`
  - `api-strict`
  - `{ preset, set, remove }`
- Development default: `api-dev`.
- Production default: `api-strict`.
- The `api-strict` preset is API-focused and should include conservative browser hardening headers:
  - `X-Content-Type-Options: nosniff`
  - `Referrer-Policy: no-referrer`
  - `X-Frame-Options: DENY`
  - `Cross-Origin-Resource-Policy: same-origin`
- Trail should not apply an aggressive default `Content-Security-Policy` to API routes in v1 because APIs usually return data, not HTML, and CSP is application-specific.
- Trail should not use deprecated browser headers such as `X-XSS-Protection`.
- HSTS (`Strict-Transport-Security`) is useful but deployment-sensitive. It should be included only when HTTPS posture is safe and explicit enough, or enabled by user configuration.
- Power users may set or remove any header explicitly.
- Guardrails should warn if production security headers are disabled or if important low-risk headers such as `X-Content-Type-Options` are missing.

### HTTPS and Trusted Proxy

- Development default: HTTPS not required.
- Production default: HTTPS required.
- For APIs, insecure production requests should be rejected by default rather than redirected.
- `https.onInsecureRequest` may support:
  - `reject`
  - `redirect`
  - `warn`
- Trail determines public HTTPS status from the direct request unless trusted proxy support is enabled.
- Trusted proxy supports simple and advanced configuration:
  - `false`: default; ignore forwarded headers.
  - `true`: trust standard forwarded headers for common proxy/load-balancer deployments.
  - advanced object config for custom header names, trusted proxy IP ranges, and client IP selection strategy.
- When trusted proxy is enabled, Trail may use `X-Forwarded-Proto` to determine public HTTPS and `X-Forwarded-For` to determine client IP for `ctx.request.ip`, rate limits, and security logs.
- Forwarded headers must not be trusted from arbitrary clients when trusted proxy is disabled.
- Advanced trusted proxy config should allow explicit proxy IP ranges for security-sensitive deployments.
- Guardrails should warn when production HTTPS is disabled, when forwarded headers appear necessary but trusted proxy is not configured, or when broad `trustedProxy: true` is used in a high-security deployment without explicit proxy IP restrictions.

### Rationale

- Reduces startup friction for local development.
- Maintains secure-by-default behavior where risk is highest (production).
- Presets keep the simple path safe, while explicit overrides let power users control CORS, headers, HTTPS, and proxy behavior.

## Part 2.6: SSRF Protection and Safe Outbound HTTP

### Decisions

- Trail provides SSRF protection for Trail-managed outbound helpers, not arbitrary direct runtime `fetch` calls.
- Trail should not monkey-patch, ban, or replace global `fetch`.
- Trail provides a recommended `safeFetch` helper for user-input URLs and third-party outbound HTTP.
- `safeFetch` uses framework-managed outbound security checks and standard Trail error behavior.
- Native `fetch` remains available as an escape hatch, but direct use is outside Trail's SSRF protection boundary.
- Outbound protection uses a simple primary allowlist: `allowedOrigins`.
- `allowedOrigins` entries are URL origins only: scheme, host, and optional port. Paths are not part of origin matching.
- Empty `allowedOrigins` means no external public origins are allowed by `safeFetch` until explicitly configured.
- Internal/private target blocking still applies regardless of `allowedOrigins`.
- Default `safeFetch` protections should block:
  - Loopback targets.
  - Private network targets.
  - Link-local targets.
  - Cloud metadata endpoints.
  - Redirects to blocked targets.
- `safeFetch` should limit redirect hops and revalidate every redirect target.
- DNS resolve and connect-time revalidation should be available as opt-in strict mode because it adds complexity and possible latency.
- Named outbound policies are deferred for v1 unless a stronger need appears; route/call-level overrides may be considered later.
- Guardrails should warn when routes accept URL input but do not use Trail-managed outbound helpers, when outbound protections are disabled in production, or when sensitive routes perform outbound HTTP without explicit origins.

### Rationale

- Defines a clear security boundary: Trail can protect `safeFetch`, but cannot prove arbitrary user `fetch` calls are safe.
- Keeps the common configuration understandable by using one `allowedOrigins` list instead of named policies.
- Denying external origins by default makes outbound access explicit while still allowing power users to opt into native `fetch` or configure allowed origins.
- Preserves advanced hardening for teams that need DNS/connect-time validation without forcing hidden latency costs on every app.

## Part 2.7: Better Auth Aligned Provider Proposal (Opt-in)

### Intent

This proposal applies when a developer chooses Trail's default scaffolded auth path.
If the developer chooses custom auth, they should still implement Trail's provider and credential strategy contracts so the standard auth-resolution middleware can run the same flow.

### Mode A: `better-auth` (Opt-in implementation path)

When selected, Trail should provide a first-party integration aligned with common industry standards:

- OAuth 2.1 / OpenID Connect compatible login and token flows where applicable.
- Session hardening defaults for browser flows (secure cookies, same-site policy, rotation support).
- Better Auth support/plugins for session/cookie, bearer token, and API key modes where selected by the developer.
- Token lifecycle support (expiry, refresh, rotation/revocation hooks).
- Credential transport best practices (auth in headers/cookies, no secrets in URLs).
- Standardized auth error mapping (`401` unauthenticated, `403` unauthorized).
- Audit-friendly auth events (login success/failure, logout, token refresh/revocation).

#### What Trail should generate in this mode

- `npx trail auth` scaffolds Better Auth wiring, provider config, credential mode choices, middleware registration, and starter policy callbacks.
- Environment-aware defaults (dev-friendly, production-safe).
- Clear extension points so teams can override defaults without forking framework internals.

### Mode B: `custom` (Interface-only path)

If Better Auth is not selected, Trail does not impose a concrete auth implementation.
Trail expects the app to implement framework provider and credential strategy interfaces.
The recommended custom path still uses Trail's standard auth-resolution middleware instead of replacing the auth pipeline with ad hoc middleware.

#### Required interfaces/contracts

1. **Auth Provider**
   - Input: request context
   - Output: normalized auth context or auth failure
   - Responsibility: coordinate configured credential strategies and provider-specific behavior

2. **Credential Strategy Adapters**
   - Responsibility: support one or more schemes (bearer, API key, session/cookie) under a consistent interface

3. **Auth Context Normalizer**
   - Responsibility: map provider-specific results into Trail's normalized `ctx.state.auth` shape

4. **Authorization Policy Callbacks**
   - Responsibility: evaluate action/resource access (`allow`/`deny`) when called by Trail guard middleware such as `authorizeResource`

5. **Security Event Emitter**
   - Responsibility: emit structured auth/audit events to app logger/telemetry

6. **Error Mapper**
   - Responsibility: map auth failures to Trail's standard error shape and HTTP semantics

### Compatibility and portability goals

- No lock-in to Better Auth for application domain logic.
- Consistent middleware and authorization behavior regardless of selected provider mode.
- Swap path: teams can migrate from `better-auth` to `custom` (or back) by re-implementing interfaces, not rewriting route handlers.

### Trade-offs

- `better-auth` mode: faster onboarding and safer defaults, with dependency on Better Auth features/plugins.
- `custom` mode: maximum flexibility and control, with higher implementation and maintenance cost.

### Acceptance criteria

- Choosing `better-auth` yields a runnable secure baseline with minimal setup.
- Choosing `custom` requires provider/strategy contract compliance; no hidden runtime coupling to Better Auth.
- Documentation clearly separates "implementation path" from "contract path".

## Implementation Alignment Notes

- Better Auth is the default scaffolded implementation path, but Trail's route and middleware contracts remain provider-neutral.
- Custom auth should normally implement Trail provider/credential strategy interfaces so credential priority, normalized auth context, standard errors, security events, and future OpenAPI metadata stay consistent.
- Trail has one request pipeline: middleware. Guards are middleware; hooks are callbacks invoked by framework-controlled code; guardrails are diagnostics.
- Rate-limit identity keys exposed to developers are only `ip` and `auth`; Trail includes the normalized route id internally.
- Field-level authorization should use named same-status response variants. Trail generates OpenAPI `oneOf` for documentation when needed, but does not expose a public `oneOf` route response helper in v1.
- `safeFetch` protection applies only to Trail-managed outbound HTTP. Native `fetch` remains an escape hatch outside Trail's SSRF protection boundary.
