# Extensibility and Testing Design (Group 6)

## Scope

This document records decisions for Group 6 in small parts.

## Part 6.1: Services and Dependency Injection

### Decisions

- Trail supports both dependency styles:
  - Plain imports and app-owned factories.
  - Optional framework-managed service injection.
- Dependency injection is a DX and testing feature, not required framework architecture.
- Applications may use plain imports without defining services in Trail config.
- If an application uses plain imports, mocking and test precision are application-owned.
- If an application uses Trail services, Trail test helpers may override services per test.

### Service Scopes

- App services are declared in `defineTrailConfig`.
- App services are created during startup and are available to all middleware, routes, lifecycle hooks, and handlers.
- Route-file services are declared in `defineRoute`.
- Route-file services are request-time services created only for the matched route file.
- Method services are declared in `createRoute`.
- Method services are request-time services created only for the matched method.
- Trail does not add a separate `requestServices` API in v1.
- Route-file and method service factories cover request-scoped dependency needs.

Example app services:

```ts
export default defineTrailConfig({
	services: ({ env, logger }) => ({
		auth: createAuthService({ env, logger }),
		db: createDb({ url: env.DATABASE_URL }),
	}),
});
```

Example route and method services:

```ts
export default defineRoute({
	services: ({ app, logger }) => ({
		authAudit: createAuthAuditService({ logger }),
	}),

	post: createRoute({
		services: ({ app }) => ({
			workspace: createWorkspaceService(app.db),
		}),

		run: async ({ input, ctx }) => {
			const session = await ctx.services.auth.login(input.body);
			const workspace = await ctx.services.workspace.findForUser(
				session.userId,
			);

			return { type: "success", data: { session, workspace } };
		},
	}),
});
```

### Factory Model

- Service factories may be sync or async.
- App service factories run during startup.
- If app service creation fails, startup fails.
- Route-file and method service factories run during request handling after route matching.
- If request-time service creation fails, Trail returns the standard `500 internalError`.
- Service creation errors must be logged with request identity when request-scoped and must apply normal redaction rules.

Factory context should provide a small typed base:

```ts
type AppServiceFactoryContext = {
	env: AppEnv;
	logger: TrailLogger;
	config: TrailConfig;
};

type RouteServiceFactoryContext = {
	app: AppServices;
	ctx: TrailContext;
	logger: TrailLogger;
};
```

Applications may extend the service types. Trail should not require class containers, decorators, or global registries for normal service authoring.

### Access Model

- Middleware and handlers access services through `ctx.services`.
- `ctx.services` is the merged typed service object for the current request.
- Startup and shutdown lifecycle hooks receive app services.
- Request lifecycle hooks use `ctx.services` through request context.

Service merge model:

```txt
app services
+ route-file services
+ method services
= ctx.services
```

### Immutability and Collisions

- Service registry objects are immutable after creation.
- Trail should freeze service registry objects where practical.
- Trail should not deep-freeze service instances.
- Service instances may manage internal mutable state, such as connection pools, caches, clients, or circuit breakers.
- Any duplicate service key across app, route-file, and method scopes fails.
- Duplicate keys should fail through TypeScript where possible and through build/startup validation for runtime safety.
- Trail does not support runtime service replacement outside test helpers.
- Runtime selection between multiple services belongs in application logic with explicitly named services.

Example intentional alternatives:

```ts
services: {
	emailEnglish: createEmailService("en"),
	emailSpanish: createEmailService("es"),
}
```

### Testing Boundary

- Trail service overrides are test-only.
- No dev/local runtime override API is provided in v1.
- Local development should configure the desired service implementation through normal config.

### Rationale

- Plain imports keep Trail simple for small apps and teams that do not want DI.
- Optional services give larger apps a typed, testable injection path.
- App services fit long-lived dependencies such as auth, database clients, email clients, and SDKs.
- Route and method services keep narrow dependencies close to the route that needs them.
- A single `ctx.services` object keeps handler and middleware code ergonomic.
- Strict duplicate detection avoids surprising shadowing between scopes.
- Freezing registries prevents accidental replacement while preserving valid mutable service internals.

## Part 6.2: Validators, Serializers, and Metadata Registry

### Decisions

- Zod is the only public schema adapter in v1.
- Trail should keep an internal schema boundary so future adapters remain possible.
- Trail does not expose a public replaceable validator system in v1.
- The v1 serializer model follows the response representation decisions from Group 1.
- Trail supports built-in approved representation helpers in v1.
- Custom arbitrary content-type serializer registries are deferred.
- Trail has a framework-owned internal metadata registry.
- The metadata registry is read-only for Trail CLI and framework tools in v1.
- The metadata registry is not a public runtime API in v1.
- Userland cannot mutate the metadata registry directly.
- Plugin access to metadata is deferred until the plugin system is defined.

### Validator Boundary

- Route input, output, middleware input, middleware rejects, config, and helper schemas use Zod in v1.
- Schema-level OpenAPI metadata on Zod schemas is first-class.
- Trail should avoid scattering direct Zod coupling through every internal subsystem.
- Internal schema handling should be shaped so future adapters such as Valibot, ArkType, or TypeBox can be evaluated later.
- Future validator support must preserve:
  - Type inference.
  - Runtime validation.
  - Validation errors with field paths.
  - OpenAPI generation.
  - Coercion and transform behavior where declared.
  - Helper composition.

### Serializer Boundary

- Trail's response builder validates the canonical payload first.
- Trail then serializes the selected representation based on the request `Accept` header and the response variant's declared `content` map.
- `application/json` is the default response representation.
- v1 response helpers should include the approved built-in set from Group 1:
  - `json()`
  - `problem()`
  - `text()`
  - `csv()`
  - binary and file helpers
- Non-JSON helpers such as `csv()` and `text()` take user callbacks that map the validated canonical payload to the wire format.
- Trail does not guess structured non-JSON layouts from schemas.
- Services return canonical payloads and do not choose the response representation in the normal path.
- Custom user-defined content types are not v1 core.

Example:

```ts
createRoute({
	responses: {
		success: {
			status: 200,
			schema: UsersSchema,
			content: {
				"application/json": json(),
				"text/csv": csv((users) => usersToCsv(users)),
			},
		},
	},
});
```

### Metadata Registry

Trail's internal metadata registry is the collected route graph and contract model.

It should include:

- Route ids, paths, route patterns, and methods.
- Params, input schemas, response variants, and response representations.
- Middleware order, middleware inputs, guarantees, and rejects.
- Auth, authorization, rate-limit, cache, and deprecation metadata.
- Global errors and framework-managed errors.
- Service scopes and service keys.
- OpenAPI operation ids, tags, examples, and documentation metadata.

The registry powers:

- OpenAPI generation.
- Built-in docs.
- Route reference documentation.
- Contract checks.
- Breaking-change checks.
- Duplicate service-key checks.
- Middleware ordering checks.
- Testing helpers.
- Future plugin/tool inspection.

### Generated Types

- Trail should avoid generated type files by default in v1.
- Trail should prefer local generic inference from `defineRoute`, `createRoute`, middleware, and config.
- A generated file such as `trail.gen.ts` should not be required for normal route authoring.
- Trail must still provide generated or inferred response unions for route handlers and services.
- Route response unions should be importable or inferable close to the route contract.
- Trail should not rewrite user route files to insert generated type aliases.
- Implementation should prefer route-local inferred aliases such as `typeof route.$inferResponse` or framework-owned declaration output when needed.
- If TypeScript limitations require app-wide generated types later, generation should be explicit or framework-managed with clear docs.
- Possible future app-wide generated type use cases include typed route references, full app route catalogs, contract-test typing, plugin APIs, and internal clients.

### TanStack-Inspired Direction

Trail can borrow the type-safety principle from TanStack Router/Start without copying the frontend model.

Useful principles:

- File contracts feed a full typed route graph.
- Route context/services merge through the hierarchy.
- Local route APIs keep types precise.
- App-wide knowledge can be derived by tooling when necessary.

Trail adaptation:

```txt
route files -> metadata registry -> typed ctx/input/services/responses/docs
```

### Rationale

- Zod gives Trail a strong v1 foundation for inference, validation, and OpenAPI.
- Avoiding public multi-validator support keeps v1 implementation focused.
- Keeping an internal schema boundary avoids unnecessary long-term lock-in.
- The serializer model is already part of the HTTP contract and should not be redefined as a broad plugin point in v1.
- A framework-owned metadata registry gives Trail one source for docs, checks, tests, and future tooling.
- Avoiding generated files by default keeps the user-facing project shape small.

## Part 6.3: Integrations Instead of Plugins

### Decisions

- Trail v1 does not provide a plugin or module system.
- Trail uses CLI integrations for setup-heavy ecosystem features.
- Integrations generate app-owned, editable files.
- Integrations use normal Trail APIs after generation.
- Integrations may install required npm/runtime packages.
- Third-party plugin APIs are deferred.
- Trail should not promise an npm plugin ecosystem in v1.

### Integration Model

Integrations are shadcn-style generated code, not runtime plugins.

Example:

```txt
npx trail auth
```

This may generate or update app-owned files such as:

```txt
auth/provider.ts
auth/policies.ts
middleware/auth.ts
trail.config.ts
.env.example
```

After generation, the application owns the files. Developers may edit, remove, or refactor them without depending on hidden plugin behavior.

### V1 Integration Candidates

Strong v1 candidates:

- Auth integration, starting with Better Auth.
- Logger integration, starting with Pino.
- Observability integration, starting with OpenTelemetry.
- Rate-limit store integration, starting with Redis.
- Testing integration, starting with the selected v1 test runner setup.

These integrations should generate code that calls normal framework APIs, such as auth provider adapters, logger adapters, observability adapters, rate-limit store adapters, service definitions, middleware, and config.

### What V1 Does Not Support

- No runtime plugin lifecycle.
- No third-party plugin registration API.
- No modules that secretly mutate the route registry.
- No plugins that add hidden routes.
- No global extension hooks that can arbitrarily change framework behavior.
- No direct metadata registry mutation by plugins or userland.

### CLI Preview and Safety

Every integration command must preview changes before writing.

The preview should show:

- Files to create.
- Files to modify.
- How files will change, as a diff or concise patch summary.
- Packages to install.
- Environment variables to add.
- Conflicts that block generation.
- Manual steps required after generation.

Default flow:

```txt
detect project
-> analyze conflicts
-> preview changes and installs
-> ask for confirmation
-> install packages
-> write files
```

If conflicts are found, Trail should stop before installing packages or writing files unless the user explicitly chooses a conflict handling path.

Rules:

- Never silently overwrite user code.
- Prefer patch-style edits for known files.
- If a file exists and differs, show the conflict and stop by default.
- Optionally generate `.new` files only with explicit user choice.
- Never delete user code.

Useful flags:

```txt
--dry-run      preview only
--yes          apply accepted defaults without prompts
--force        allow explicit overwrite/conflict behavior
--no-install   write files without installing packages
```

`--yes` applies file changes and installs packages after conflict checks.

### Package Installation

Integrations may install packages needed by the generated code.

Trail should use the same package manager implied by the command invocation when known:

```txt
npx              -> npm
pnpm dlx / pmpx  -> pnpm
yarn dlx         -> yarn
bunx             -> bun
deno             -> deno
```

Trail should also inspect project files when command source is ambiguous:

```txt
pnpm-lock.yaml        -> pnpm
yarn.lock             -> yarn
bun.lock / bun.lockb  -> bun
package-lock.json     -> npm
deno.json / deno.lock -> deno
```

If command source and project lockfile disagree, Trail should warn and ask before installing.

Install behavior:

- Runtime packages are installed as normal dependencies.
- Test/build-only packages are installed as dev dependencies.
- Package installs happen after conflict checks and before file writes.
- If package installation fails, Trail should not write generated files by default.

Examples:

```txt
npx trail logger
-> npm install pino
```

```txt
pnpm dlx trail observability
-> pnpm add @opentelemetry/api
```

```txt
bunx trail testing
-> bun add -d vitest
```

### Rationale

- Plugin systems are costly to maintain and create ordering, compatibility, and security risk.
- Hidden plugin mutation conflicts with Trail's schema-first and type-safe direction.
- Generated integrations give users a fast starting point while keeping code ownership in the application.
- Narrow adapters still cover framework-owned extension points without creating a broad plugin API.
- Preview-first generation protects existing projects from accidental file churn.

## Part 6.4: Testing Helpers

### Decisions

- Vitest is the default testing integration for v1.
- `npx trail testing` installs test dependencies and generates setup files.
- The testing integration defaults to setup only.
- The CLI should ask whether to generate example tests.
- Trail wraps the v1 Hono testing surface instead of exposing Hono as the public testing API.
- Trail test helpers should run HTTP integration tests in memory without starting a real network server by default.
- Future runtime adapters may provide their own internal test harness implementation without changing Trail's public testing API.
- Service overrides are test-only and must satisfy the same typed service contract as the real services.
- OpenAPI contract testing stays CLI-only in v1.
- Trail does not provide OpenAPI assertion helpers in v1.
- Middleware tracing is test-only instrumentation.

### Testing Integration

Default command:

```txt
npx trail testing
```

The command should generate setup files such as:

```txt
tests/helpers/trail-test.ts
vitest.config.ts
```

If the user chooses examples, it may also generate files such as:

```txt
tests/routes/example-route.test.ts
tests/middleware/example-middleware.test.ts
tests/http/example.integration.test.ts
```

Optional examples should be confirmed by the user. The default is setup only.

This follows the broader integration rule:

- Some integrations are mostly generated implementation and do not need an examples prompt.
- Optional examples should be prompted before generation.
- Example generation must appear in the preview before files are written.

### Handler Unit Tests

Trail should provide a route handler unit helper.

The helper should test the route contract boundary without HTTP parsing, content negotiation, or serialization.

Example:

```ts
const result = await testRoute(usersRoute.post, {
	input: { body: validBody },
	services: {
		users: fakeUsersService,
	},
});

expect(result).toEqual({
	type: "success",
	data: user,
});
```

Use cases:

- Test handler mapping from validated input to declared response variants.
- Test service result mapping.
- Test typed `ctx.services` and `ctx.state` usage.
- Avoid network and parser setup for focused handler behavior.

### Middleware Unit Tests

Trail should provide a middleware unit helper.

The helper should test middleware contracts directly:

- Required prior state.
- Provided or guaranteed state.
- Early reject variants.
- `next` behavior.

Example:

```ts
const result = await testMiddleware(requireAuth(), {
	ctx: anonymousCtx(),
});

expect(result).toRejectWith("missingCredentials");
```

Middleware tests must align with the existing middleware model:

```txt
global -> group -> segment folder -> route file -> method contract -> handler
```

`requires` must be fulfilled by previous `guarantees`, and tests should make this easy to verify.

### HTTP Integration Tests

Trail should provide an in-memory app test harness.

In v1, the harness may use Hono's `app.request()` internally. Hono supports sending a request directly to an app and receiving a standard `Response`, which fits Trail's no-server default.

Trail's public helper should remain adapter-neutral:

```ts
const app = createTestApp({
	config,
	services: {
		users: fakeUsersService,
	},
});

const res = await app.request("/users", {
	method: "POST",
	body: json(validBody),
});

expect(res.status).toBe(201);
expect(await res.json()).toEqual(expected);
```

Trail may also support real server tests later, but the default v1 path should be in-memory.

### Service Overrides

Test helpers should support typed service overrides.

Rules:

- Overrides are available only through testing helpers.
- Overrides must satisfy the same TypeScript service contract as the real service.
- Overrides should be scoped per test app or per test invocation.
- Overrides should not mutate the production service registry.
- If users use plain imports instead of Trail services, Trail cannot mock those automatically.

Example:

```ts
createTestApp({
	config,
	overrides: {
		services: {
			email: fakeEmailService,
			queue: fakeQueueService,
		},
	},
});
```

This keeps fakes aligned with route and middleware expectations. If a route expects `ctx.services.workspace.findForUser`, the fake workspace service must implement that shape.

### OpenAPI Contract Testing

OpenAPI contract testing remains CLI-owned in v1.

Use:

```txt
trail openapi check
trail openapi breaking
```

Trail should not add a separate OpenAPI assertion helper in v1. This avoids splitting contract testing across both CLI workflows and unit-test helpers.

### Error Snapshot Helper

Trail should provide a helper for standard framework error responses.

Use cases:

- Validation error shape stability.
- Standard auth error shape stability.
- Standard rate-limit and unsupported media type errors.
- Problem-details compatibility.

The helper should normalize unstable fields before snapshotting or comparison:

- Request ids.
- Timestamps.
- Dynamic `instance` values.
- Stack traces.

Example:

```ts
const res = await app.request("/users", {
	method: "POST",
	body: json({ email: "bad" }),
});

await expectTrailError(res).toMatchErrorSnapshot();
```

### Middleware Ordering Helper

Trail should provide test-only middleware tracing.

Use cases:

- Assert middleware order.
- Verify route-file middleware runs before method middleware.
- Verify guards run after required data loaders.
- Catch regressions in group or segment middleware composition.

Example:

```ts
const trace = createMiddlewareTrace();

const app = createTestApp({
	config,
	traceMiddleware: trace,
});

await app.request("/users/123");

expect(trace).toHaveOrder([
	"global.authResolution",
	"group.tenant",
	"route.loadUser",
	"method.requirePermission",
	"handler",
]);
```

This is not a normal runtime API. Runtime observability belongs to the logging, metrics, and tracing model from Group 5.

### Rationale

- Vitest gives Trail a modern default test runner without forcing users to design setup from scratch.
- Hono already supports in-memory request testing, so Trail should reuse that internally for the v1 adapter.
- Wrapping Hono keeps Trail's public testing API stable if future adapters such as Express or Fastify are added.
- Typed service overrides make DI useful for testing without requiring heavy module mocking.
- OpenAPI contract checks are stronger and clearer as CLI commands.
- Error and middleware-order helpers cover framework-specific behavior that generic HTTP test tools do not make easy.

## Part 6.5: Security Testing and Documentation DX

### Decisions

- Security regression test generation is separate from the normal testing integration.
- `trail testing` sets up the default test runner and core Trail test helpers.
- `trail security testing` generates optional security regression example tests.
- Generated API docs are the OpenAPI and Scalar documentation already defined in Group 3.
- Route reference documentation is a CLI and metadata-registry feature.
- The v1 guide set should include:
  - Route reference documentation.
  - Error catalog.
  - Auth guide.
  - Middleware and Integrations guide.
  - Deployment guide.
  - Security recommendations.

### Security Regression Testing

Security regression examples should be generated through:

```txt
trail security testing
```

This command should follow the same preview-first integration safety rules:

- Show files to create.
- Show files to modify.
- Show how files will change.
- Show packages to install, if any.
- Detect conflicts before installing or writing.
- Ask for confirmation before writing unless `--yes` is used.

The command should inspect the project and generate examples that match configured Trail features.

Generic examples may cover:

- Protected route without credentials returns `401`.
- Authenticated but unauthorized request returns `403`.
- Invalid request body returns the standard validation error.
- Unsupported request `Content-Type` returns `415`.
- Unsupported response `Accept` returns `406`.
- Rate limit exceeded returns `429` when rate limits are configured.
- CORS preflight behavior when CORS is configured.

Integration-specific examples may be generated only when the matching integration is detected:

- Better Auth integration detected: generate Better Auth-aware session, bearer, or API key examples depending on config.
- Custom auth detected: generate generic protected-route examples with TODO placeholders for app-specific credential creation.
- Rate-limit store configured: generate examples that use the configured limiter behavior where practical.

If Trail cannot safely generate a specific example, it should explain why and skip that example rather than generating misleading tests.

### Generated API Docs

Generated API docs mean the Group 3 OpenAPI docs surface:

- `openapi.json` emitted by default.
- Built-in documentation UI.
- Scalar as the default renderer.
- Swagger UI as an optional renderer.
- Enabled by default in development.
- Explicit enablement required in production.
- Production exposure guardrails for docs UI and raw `openapi.json`.

Trail should not create a second generated API documentation system in v1.

### Route Reference

Route reference is developer-facing documentation generated from the metadata registry.

It answers:

```txt
Where is this route defined, and what Trail metadata applies to it?
```

Default command:

```txt
trail routes
```

Default behavior:

- Print a human-readable route reference to the terminal.
- Do not write files.

Supported output formats:

```txt
trail routes --format json
trail routes --format markdown
trail routes --format yaml
```

Optional file output:

```txt
trail routes --format markdown --output docs/routes.md
```

Route reference output should include useful developer metadata such as:

- Method and path.
- Route id and route pattern.
- Source file.
- Operation id.
- Tags.
- Middleware chain.
- Required auth or capabilities.
- Declared service keys.
- Response variants and statuses.
- Cache and deprecation metadata when present.

Example:

```txt
GET /users/:id
file: routes/users/$id/route.ts
operationId: getUserById
middleware:
  global.authResolution
  route.loadUser
  method.requirePermission
services:
  users
responses:
  success 200
  notFound 404
auth:
  bearer/session required
```

### Error Catalog

Trail should provide an error catalog for framework-managed errors.

The catalog should document:

- Stable error code.
- HTTP status.
- Default problem-details shape.
- When the error occurs.
- Whether the error is framework-managed, middleware-managed, or application-declared.
- Notes about safe public messages versus internal logs.

The catalog should cover standard errors such as:

- Validation errors.
- Unsupported request media type.
- Not acceptable response media type.
- Authentication failures.
- Authorization failures.
- Rate limit failures.
- Request timeout.
- Internal error.

### V1 Guides

The Auth guide should cover:

- Better Auth integration path.
- Custom auth provider path.
- Credential priority.
- `requireAuth`.
- `requirePermission`.
- `authorizeResource`.
- Standard auth errors.
- Security events.

The Middleware and Integrations guide should cover:

- Middleware levels and order.
- `requires`, `provides`, `guarantees`, `input`, `rejects`, and `openapi`.
- Middleware testing.
- Integration commands.
- Why integrations are generated code instead of plugins.

The Deployment guide should cover:

- Build, release, and run separation.
- Env/config validation.
- Port binding.
- Health and readiness.
- Graceful shutdown.
- Stateless process posture.
- Production docs exposure.

The Security recommendations guide should cover:

- Auth and authorization posture.
- Rate-limit profiles.
- CORS and security headers.
- HTTPS and trusted proxy.
- SSRF-safe outbound HTTP.
- Sensitive data in URLs.
- Logging redaction.
- Security regression testing.

### Rationale

- Security tests need app-specific auth and configuration knowledge, so they should be generated separately from basic test setup.
- Keeping OpenAPI docs as the generated API docs avoids duplicate documentation systems.
- A CLI route reference gives developers framework-specific route insight without exposing another runtime surface.
- The v1 guide set closes the practical DX gap between framework contracts and real project setup.
