# Runtime and Operations Design (Group 5)

## Scope

This document records decisions for Group 5 in small parts.

## Part 5.1: Structured Logging and Request Identity

### Decisions

- Routa defines a small structured logger interface.
- Routa ships a basic structured console logger by default.
- Logging backends should be easy to plug in through a custom logger or adapter; Routa's public contract does not depend on any logging package.
- Custom loggers must implement Routa's logger interface.
- The logger interface supports common levels:
	- `trace`
	- `debug`
	- `info`
	- `warn`
	- `error`
	- `fatal`
- The logger interface includes a `silent` no-op for explicitly discarded events.
- The logger interface supports child loggers with bindings.
- The logger interface supports binding inspection and level checks.
- `ctx.logger` exposes the configured runtime logger to route handlers.
- Applications can derive child loggers when they need request or service bindings.

Example interface shape:

```ts
type RoutaLogger = {
	log(event: RoutaLogEvent): void;
	trace(event: string, message: string, data?: object): void;
	debug(event: string, message: string, data?: object): void;
	info(event: string, message: string, data?: object): void;
	warn(event: string, message: string, data?: object): void;
	error(event: string, message: string, data?: object): void;
	fatal(event: string, message: string, data?: object): void;
	silent(event: string, message: string, data?: object): void;
	child(bindings: object): RoutaLogger;
	bindings(): object;
	isLevelEnabled(level: RoutaLogLevel | "silent"): boolean;
};
```

### Request ID

- Routa always generates its own `ctx.core.requestId`.
- The default generated ID format is UUID.
- Routa returns the generated request ID in response headers by default.
- The default response header is `x-request-id`.
- Incoming request ID headers do not replace Routa's generated request ID.
- An incoming request ID may be stored separately as `ctx.core.externalRequestId` when configured.

### Correlation ID

- Routa does not generate correlation IDs.
- Routa accepts a correlation ID only when a configured incoming correlation header is present and valid.
- The default correlation header is `x-correlation-id`.
- If a valid correlation ID arrives, Routa sets `ctx.core.correlationId`.
- If no valid correlation ID arrives, `ctx.core.correlationId` is absent.
- Routa returns `x-correlation-id` only when a valid correlation ID arrived on the request.

### Identity Header Configuration

- Request and correlation header names are configurable.
- Incoming identity header values are validated, length-limited, and log-safe.
- Invalid identity headers are ignored by default.
- Invalid identity headers emit a structured debug log event.
- Apps may configure invalid identity header behavior:
  - `ignore`
  - `warn`
  - `reject`
- `reject` is intended for strict internal APIs and should return `400 Bad Request`.

Example invalid-header event:

```ts
logger.debug(
	"request_identity.invalid_correlation_id",
	"Ignored invalid correlation id",
	{
		header: "x-correlation-id",
		reason: "too_long",
		requestId,
	},
);
```

### Security Events

- Security events use the same logger by default.
- Security events are structured log entries with stable `event` names.
- Security event logs should avoid raw secrets, tokens, and sensitive credential values.
- Applications may route security events elsewhere by replacing or wrapping the logger.

Example security event:

```ts
logger.warn(
	"security.auth.invalid_credentials",
	"Invalid credentials",
	{
		requestId,
		correlationId,
		authScheme: "bearer",
	},
);
```

### Rationale

- A small logger interface keeps Routa portable.
- A built-in structured JSON logger gives usable defaults without forcing a dependency.
- The portable interface is stylistically familiar to structured-logging users while allowing any logging strategy.
- Always generating Routa's own request ID gives each handled request a trustworthy local trace handle.
- Correlation IDs represent upstream or cross-service workflows, so Routa should preserve them when provided instead of inventing them.
- Using one logger for normal and security events keeps v1 simple while preserving routing options through custom logger implementations.

## Part 5.2: Metrics and Tracing

### Decisions

- Metrics are disabled by default.
- Tracing is disabled by default.
- Metrics are collected only when metrics are explicitly enabled in Routa configuration.
- Tracing spans are created only when tracing is explicitly enabled in Routa configuration.
- Routa defines observability interfaces rather than forcing a metrics or tracing vendor.
- Routa should make OpenTelemetry and Prometheus easy to integrate.
- Routa ships first-party OpenTelemetry adapters for metrics and tracing in v1.
- Routa may ship a Prometheus metrics helper or adapter in v1 if practical.
- Vendor-specific adapters such as Datadog are not v1 core unless demand is strong.
- Vendor-specific platforms should usually be supported through OpenTelemetry first.

Example configuration shape:

```ts
observability: {
	metrics: {
		enabled: true,
		adapter: otelMetrics(),
	},
	tracing: {
		enabled: true,
		adapter: otelTracing(),
		frameworkSpans: false,
	},
}
```

### Metrics

- Metrics v1 records whole-request metrics only.
- Detailed framework step timing should not be emitted as default metrics in v1.
- Built-in request metrics should cover:
  - request duration
  - active requests
  - status code counts
  - error counts
  - route method
  - route pattern
- Metrics labels should use low-cardinality values.
- Metrics should use route patterns, not raw paths.

Examples:

```txt
method=GET
route=/users/$id
status=200
```

Avoid:

```txt
route=/users/123
```

Example metrics interface shape:

```ts
type RoutaMetrics = {
	increment(name: string, value: number, labels?: object): void;
	gauge(name: string, value: number, labels?: object): void;
	histogram(name: string, value: number, labels?: object): void;
};
```

### Metrics Exposure

- Routa does not expose a default `/metrics` endpoint.
- Metrics exposure is application-owned.
- Applications decide whether metrics are exposed through:
  - a protected HTTP endpoint
  - an internal-only endpoint
  - a sidecar or collector
  - direct adapter export
  - deployment-platform observability
- If Routa later provides a metrics endpoint helper, mounting it must be explicit.
- Production exposure of a metrics endpoint should have guardrails.

### Tracing

- Routa aligns tracing with OpenTelemetry semantic conventions.
- When tracing is enabled, Routa creates one request span by default.
- Framework child spans are disabled by default.
- Developers may enable framework child spans with `frameworkSpans: true`.
- Framework child spans are intended for debugging request internals.
- Framework child spans may cover:
  - request parsing
  - input validation
  - middleware pipeline
  - handler execution
  - response serialization
- OpenTelemetry should not be a required dependency unless the application configures OpenTelemetry tracing or metrics.

### Rationale

- Opt-in observability keeps the default runtime lightweight.
- Whole-request metrics give the highest-value operational signal with low complexity.
- Detailed framework timing is better suited to traces than default metrics because traces explain one request without creating broad metric noise.
- Route patterns avoid high-cardinality metric labels and accidental user data exposure.
- A default `/metrics` endpoint can expose traffic patterns, route names, status rates, and failure behavior, so applications should control how metrics are exposed and protected.
- OpenTelemetry gives broad vendor interoperability without locking Routa to one observability platform.

## Part 5.3: Health, Readiness, and Liveness

### Decisions

- Routa provides a health endpoint by default.
- The default health path is `/health`.
- Health is a liveness signal only.
- Health answers whether the process can answer HTTP.
- Health does not check dependencies.
- Health does not check application readiness.
- Health returns `200 OK` while Routa can serve HTTP.
- Health may return `503 Service Unavailable` only for framework lifecycle states such as shutting down or fatal state before process exit.
- Most fatal states should terminate the process instead of relying on a failing health response.

Example healthy response:

```json
{
	"status": "ok"
}
```

Example unhealthy response:

```json
{
	"status": "unhealthy"
}
```

### Readiness

- Routa provides a readiness endpoint only when readiness checks are configured.
- The default readiness path is `/ready`.
- Readiness checks are developer-defined.
- Readiness answers whether this process should receive traffic.
- Readiness may check dependencies such as databases, caches, queues, auth providers, and required external services.
- Failed readiness returns `503 Service Unavailable`.
- Readiness checks use a short cached result by default.
- The default readiness cache TTL is `5s`.
- The readiness cache TTL is configurable.
- Developers may set the TTL to `0` for always-live checks.

Example configuration shape:

```ts
operations: {
	health: {
		enabled: true,
		path: "/health",
	},
	readiness: {
		path: "/ready",
		cacheTtl: "5s",
		checks: [databaseCheck, redisCheck],
	},
}
```

### Readiness Response Detail

- Development readiness responses may include check details.
- Production readiness responses are minimal.
- Production readiness responses must not expose dependency names, timings, connection details, failure messages, or internal topology.

Example production response:

```json
{
	"status": "ready"
}
```

Example production failure response:

```json
{
	"status": "not_ready"
}
```

Example development failure response:

```json
{
	"status": "not_ready",
	"checks": [
		{ "name": "database", "status": "pass", "durationMs": 8 },
		{
			"name": "redis",
			"status": "fail",
			"durationMs": 40,
			"message": "connection refused"
		}
	]
}
```

### Readiness Observability

- Full readiness detail should be emitted to configured observability sinks.
- If structured logging is configured, readiness failures should emit structured log events.
- If metrics are configured, readiness should emit check status and duration metrics.
- If tracing is configured, readiness requests may create request spans.
- Individual readiness checks may create child spans when framework or operation spans are enabled.
- Observability detail is for operators; HTTP response detail is for callers.

Example readiness failure log:

```ts
logger.warn(
	{
		event: "readiness.failed",
		status: "not_ready",
		checks: [
			{ name: "database", status: "fail", durationMs: 42, reason: "timeout" },
			{ name: "redis", status: "pass", durationMs: 6 },
		],
		requestId,
	},
	"Readiness check failed",
);
```

### Liveness and Readiness Split

- `/health` answers whether the process should be restarted.
- `/ready` answers whether the process should receive traffic.

Examples:

```txt
database down:
  /health -> 200 ok
  /ready  -> 503 not_ready

process shutting down:
  /health -> 503 unhealthy
  /ready  -> 503 not_ready
```

### Rationale

- A default health endpoint gives deployment platforms a simple liveness probe.
- Keeping dependency checks out of health avoids restarting a healthy process during a database, cache, or network outage.
- Requiring explicit readiness checks avoids exposing a meaningless readiness endpoint.
- Minimal production readiness bodies reduce information disclosure.
- Detailed readiness data belongs in logs, metrics, and traces, where operators can secure and query it.
- A short readiness cache prevents frequent probes from hammering dependencies or amplifying outages.

## Part 5.4: Log Redaction and Log Injection Protection

### Decisions

- Routa enables default redaction for obvious secrets and sensitive values.
- Redacted values are replaced with `"[Redacted]"`.
- Redaction keeps the original log shape when possible.
- Developers can add custom redaction paths.
- Routa protects against log injection by escaping or stripping control characters from user-controlled logged values.
- Routa should prefer structured JSON logs over string-concatenated logs.
- Raw request bodies are not logged by default.
- Raw request headers are not logged by default.
- Routa should automatically log only selected safe request metadata.

Default redaction should cover:

- `authorization`
- `cookie`
- `set-cookie`
- configured API key headers
- bearer tokens
- session tokens
- password-like fields
- secret-like fields
- token-like fields
- key-like fields

Example redacted log:

```json
{
	"authorization": "[Redacted]",
	"password": "[Redacted]",
	"requestId": "018f7c5e-5a90-7bd4-8a27-0c44fd2a8f4d"
}
```

### Custom Redaction

- Applications may add domain-specific redaction paths.
- Custom paths are useful for fields such as payment data, government IDs, private tenant data, or internal business identifiers.

Example configuration shape:

```ts
logging: {
	redact: {
		defaults: true,
		paths: ["user.ssn", "payment.cardNumber"],
	},
	logInjectionProtection: true,
}
```

### Raw Request Logging

- Development may allow raw request body or header logging without an unsafe flag.
- Redaction still applies by default in development.
- Production raw request body or header logging requires explicit unsafe configuration.
- Production unsafe raw request logging emits a startup guardrail warning by default.
- Strict mode should fail startup for production unsafe raw request logging unless the risk is explicitly acknowledged.
- Redaction remains enabled by default even for raw logs.
- Disabling production redaction requires a separate explicit unsafe configuration.

Example production raw logging configuration:

```ts
logging: {
	rawRequestLogging: {
		enabled: true,
		unsafe: true,
		acknowledgeProductionRisk: true,
		include: {
			headers: true,
			body: true,
		},
	},
	redact: {
		defaults: true,
		paths: ["payment.cardNumber"],
	},
}
```

If production redaction is disabled, the configuration should be intentionally explicit:

```ts
logging: {
	redact: {
		defaults: false,
		unsafeAllowSecretsInLogs: true,
	},
}
```

### Log Injection Protection

- Routa should sanitize user-controlled values before placing them in logs.
- Newlines and control characters in user-controlled log values should be escaped or stripped.
- Incoming identity headers, request headers, query strings, validation messages, and error details should be treated as user-controlled unless Routa generated them.
- Invalid or suspicious log input should not create public response errors by default.

Example unsafe input:

```txt
bob
{"level":"error","message":"admin logged in"}
```

Safe structured output should preserve the value as data, not as a new log entry.

### Rationale

- Logs often leave the application boundary and are stored in third-party systems, shared dashboards, support tools, or incident archives.
- Default redaction prevents accidental leakage of tokens, cookies, passwords, and other sensitive data.
- Replacing values with `"[Redacted]"` makes it clear that a field existed while keeping the secret hidden.
- Log injection protection prevents user input from forging log lines, breaking parsers, or creating misleading security events.
- Production raw request logging can be legitimate during debugging, but it is risky enough to require explicit unsafe configuration and guardrails.

## Part 5.5: Environment Config, Secrets, and Startup Validation

### Decisions

- Routa has one typed runtime config boundary through `createRouta`.
- Routa config includes framework-level runtime config such as:
  - server
  - logging
  - observability
  - security
  - operations
- Routa validates config before starting the server.
- If config validation fails, Routa does not start the server.
- Config validation failure blocks startup in all environments.
- Config validation errors must redact secrets.
- Default env source is `process.env`.
- Routa should provide a Zod-based `defineEnv` helper.
- `defineEnv` reads `process.env` once by default.
- Parsed env values are reused after validation instead of reading `process.env` throughout the app.
- Developers may bring their own env loading implementation.
- Tools such as Varlok may inject env before Routa reads or receives config.
- Routa does not force dotenv, Varlok, or any specific env loader.
- Routa documentation should recommend native runtime env loading first for local `.env` files, such as Node or Bun built-in support.

Example configuration shape:

```ts
const env = defineEnv({
	NODE_ENV: z.enum(["development", "test", "production"]),
	PORT: z.coerce.number().default(3000),
	PUBLIC_API_ORIGIN: z.string().url(),
	DATABASE_URL: secret(z.string().url()),
	JWT_SECRET: secret(z.string().min(32)),
});

export default defineRoutaConfig({
	env,
	server: {
		port: env.PORT,
	},
	security: {
		jwt: {
			secret: env.JWT_SECRET,
		},
	},
	logging: {},
	observability: {},
	operations: {},
});
```

Example bring-your-own env loader:

```ts
const env = myEnvLoader();

export default defineRoutaConfig({
	env,
	server: {
		port: env.PORT,
	},
});
```

### Secrets

- Secrets should come from env or backing services, not hardcoded route files.
- Missing required secrets fail startup.
- Invalid secrets fail startup.
- Routa provides `secret(...)` metadata for config values that must be treated as sensitive.
- `secret(...)` guarantees redaction in config errors, startup logs, and config inspection surfaces controlled by Routa.
- `secret(...)` does not guarantee that developers cannot manually leak a secret.
- Varlok-style active secret leak prevention is outside Routa v1's core responsibility.
- Applications that need active secret exposure detection should use Varlok or a dedicated secret-management tool.

Example secret validation:

```ts
const env = defineEnv({
	JWT_SECRET: secret(z.string().min(32)),
});
```

Config errors should say:

```txt
JWT_SECRET is required
```

They should not include the secret value.

### Runtime Access

- Route handlers, utilities, services, and business logic should not read directly from `process.env`.
- Framework-owned secrets should be passed into framework config at startup.
- App-owned secrets should be passed into app-owned utilities or services at startup.
- Optional dependency wiring is defined in `extensibility_and_testing_design.md`.
- App-owned services may be created with parsed env and used through plain imports or optional Routa service wiring.

Example app-owned service setup:

```ts
const jwtService = createJwtService({
	secret: env.JWT_SECRET,
	issuer: env.JWT_ISSUER,
});
```

Route code should use the configured service, not `process.env`:

```ts
const token = await jwtService.sign({
	sub: ctx.state.auth.principal.id,
});
```

### `ctx.core.env`

- `ctx.core.env` exists for request-safe env values.
- `ctx.core.env` defaults to empty.
- Developers must explicitly expose each safe env value to `ctx.core.env`.
- Secrets are never exposed to `ctx.core.env` by default.
- `ctx.core.env` should expose validated values only, not raw `process.env`.

Example:

```ts
export default defineRoutaConfig({
	env,
	exposeEnvToContext: {
		NODE_ENV: true,
		PUBLIC_API_ORIGIN: true,
	},
});
```

Allowed in handlers:

```ts
ctx.core.env.NODE_ENV;
ctx.core.env.PUBLIC_API_ORIGIN;
```

Not exposed by default:

```ts
ctx.core.env.JWT_SECRET;
ctx.core.env.DATABASE_URL;
```

### Rationale

- Reading and validating env once improves type safety and avoids repeated untyped `process.env` access.
- Startup validation prevents partially configured services from accepting traffic.
- Keeping env loading pluggable lets teams use platform env, native runtime `.env` support, Varlok, Docker, Kubernetes, CI, or other tooling.
- Secret metadata gives Routa enough information to redact sensitive values without pretending to own full secret-management behavior.
- Explicit `ctx.core.env` exposure prevents accidental secret access from request handlers while preserving convenient access to safe runtime values.

## Part 5.6: Deployment Runtime Model

### Decisions

- Routa follows a Twelve-Factor-style deployment model.
- Build, release, and run concerns should stay separate.
- The build step creates artifacts only.
- The build step should not require production secrets.
- The release/startup phase validates config.
- The run phase starts the HTTP process.
- Config validation blocks startup when invalid.
- Dependency health belongs primarily to readiness checks, not default startup blocking.
- Startup should block on dependency checks only when the developer explicitly configures required startup checks.
- Routa should document release-phase patterns such as migrations, but release hooks are not v1 core.

### Port Binding

- Routa binds to a configured port.
- Production should require `PORT` from config or env.
- Development may default to port `3000`.
- Invalid or missing production port config fails startup.

Example:

```ts
const env = defineEnv({
	NODE_ENV: z.enum(["development", "test", "production"]),
	PORT: z.coerce.number().default(3000),
});

export default defineRoutaConfig({
	server: {
		port: env.PORT,
	},
});
```

### Stateless Process Model

- Routa recommends stateless application processes by default.
- Persistent data should live in backing services configured through env/config.
- Backing services include databases, caches, queues, object storage, secret managers, and external APIs.
- Temporary local files are allowed.
- Durable local filesystem persistence in production should emit a guardrail warning by default.
- Strict mode may fail startup for declared durable local persistence unless the risk is explicitly acknowledged.
- Routa does not monkey-patch filesystem APIs.
- Routa does not attempt to fully detect arbitrary user-code filesystem persistence in v1.
- Routa warns only for declared or Routa-managed durable local persistence.

Example storage posture:

```ts
runtime: {
	stateless: true,
	storage: {
		localPersistence: "temporary",
		tempDir: "/tmp",
	},
}
```

Example production durable local persistence acknowledgement:

```ts
runtime: {
	storage: {
		localPersistence: "durable",
		path: "./data",
		acknowledgeProductionRisk: true,
	},
}
```

Routa-managed features that use durable local disk should participate in this guardrail model, such as:

- local file upload storage
- local durable caches
- generated artifacts written at runtime
- future first-party storage adapters that persist to local disk

### Fast Startup

- Routa should be designed for fast startup.
- v1 should not define a hard startup time target.
- Startup timing should be visible through structured logs.
- Startup timing may be emitted through metrics when metrics are configured.
- Heavy work should be explicit.
- Long-running dependency checks should normally live in readiness, not startup.
- Expensive one-time work such as migrations should run in a release phase outside the request-serving process.

### Rationale

- Separating build, release, and run keeps production deployments predictable and avoids leaking production secrets into build artifacts.
- Requiring explicit production port config matches common platform deployment behavior.
- Stateless process defaults make horizontal scaling and replacement safer.
- Routa cannot reliably detect every local filesystem write without invasive and fragile behavior.
- Guardrails for declared or Routa-managed durable local persistence keep the framework honest without pretending to police all user code.
- Keeping dependency checks in readiness avoids delaying startup or creating crash loops when a dependency is temporarily unavailable.

## Part 5.7: Lifecycle Hooks

### Decisions

- Lifecycle hooks are runtime and observability callbacks.
- Lifecycle hooks are not middleware.
- Request lifecycle hooks are observe-only in v1.
- Request lifecycle hooks cannot mutate `ctx.state`.
- Request lifecycle hooks cannot change route input.
- Request lifecycle hooks cannot replace responses.
- Middleware remains the request behavior and typed context mechanism.
- Routa provides default lifecycle logging through the configured logger.
- Applications may add hooks for extra logging, metrics, traces, reporting, cleanup, and flushing.
- Service logger and dependency access follow the optional dependency wiring model in `extensibility_and_testing_design.md`.

Default lifecycle events should include:

- startup started
- startup completed
- startup failed
- shutdown started
- shutdown completed
- shutdown failed
- request started
- request completed
- request errored

Default lifecycle log fields should include:

- `event`
- `requestId` when request-scoped
- `correlationId` when present
- `method` when request-scoped
- `route` when known
- `status` when available
- `durationMs` when available
- `errorCode` when available

### Startup Hooks

- Startup hooks run after config validation.
- Startup hooks run before the server accepts traffic.
- Startup hooks are intended for lightweight initialization and observability setup.
- Startup hook failure blocks startup.
- Heavy work such as migrations, long imports, or expensive external syncs should run in a release phase or explicit tooling instead of normal startup hooks.

Example:

```ts
lifecycle: {
	onStartup: [
		async ({ config, logger }) => {
			logger.info({ event: "app.starting" }, "Starting app");
		},
	],
}
```

### Shutdown Hooks

- Shutdown hooks run during graceful shutdown.
- On shutdown, Routa should mark readiness as not ready.
- Routa should stop accepting new requests.
- Routa should wait for in-flight requests up to the configured shutdown grace timeout.
- Routa should run shutdown hooks for cleanup and flushing.
- Shutdown hook failure logs an error and shutdown continues.

Use cases include:

- closing database pools
- flushing logs
- flushing metrics and traces
- stopping background workers
- releasing locks

Example:

```ts
lifecycle: {
	onShutdown: [
		async () => {
			await dbPool.close();
			await metrics.flush();
		},
	],
}
```

### Request Hooks

- `onRequestStart` runs after Routa creates basic request context.
- `onRequestEnd` runs after a response is produced.
- `onRequestError` runs when an error happens during request handling.
- Request hook failures are logged and do not fail the request by default.
- Hook errors must be redacted and log-safe.

Example:

```ts
lifecycle: {
	onRequestEnd: [
		({ ctx, response }) => {
			metrics.increment("api.request", 1, {
				route: ctx.core.routeId,
				status: response.status,
			});
		},
	],
	onRequestError: [
		({ ctx, error }) => {
			sentry.captureException(error, {
				tags: {
					requestId: ctx.core.requestId,
				},
			});
		},
	],
}
```

### Timeouts

- Shutdown grace timeout defaults to `30s`.
- Hook timeout defaults to `5s`.
- Both timeouts are configurable.

Example:

```ts
lifecycle: {
	shutdownGraceTimeout: "30s",
	hookTimeout: "5s",
}
```

### Rationale

- Hooks give applications safe runtime integration points without weakening the middleware type model.
- Keeping request hooks observe-only prevents invisible behavior changes outside Routa's contract system.
- Default lifecycle logging gives useful operational visibility with no custom setup.
- Configurable hooks let applications integrate their own telemetry, cleanup, and incident tooling.
- Service logger access belongs with Group 6 dependency and service-container decisions because services are application-owned.
