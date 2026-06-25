# Trail Testing Strategy

## Purpose

This document defines how Trail itself should be tested.

It is not an acceptance spec and it is not the user-facing test-helper design. Specs describe expected behavior. Test helpers describe APIs Trail may give application developers. This file describes the internal validation matrix needed to prove Trail works.

## Core Rule

Test each Trail promise at the layer where it can actually fail.

Trail is not only a runtime library. It is also:

- a type-level API
- a contract graph validator
- a code generator
- a CLI
- an OpenAPI drift and breaking-change tool
- a Hono runtime adapter in v0

Runtime request tests alone are not enough because Trail's core value includes compile-time inference, stable generated source, framework-aware diagnostics, and OpenAPI contract alignment.

## Test Matrix

### Type Tests

Use type tests for compile-time promises:

- handler input inference from route schemas
- response variant constraints
- response `data` typing from declared schemas
- middleware-driven `ctx` inference
- compile-fail cases for undeclared response variants
- compile-fail cases for missing middleware-provided ctx
- route-specific ctx boundaries, so admin/protected ctx does not leak into public routes

Examples:

```ts
// compile-pass
return { type: "success", data: user };

// compile-fail
return { type: "emailConflict", data: error };

// compile-pass when auth middleware is in the resolved chain
ctx.state.auth.principal.id;

// compile-fail when auth middleware is absent
ctx.state.auth.principal.id;
```

Possible tools:

- Vitest type testing
- `tsd`
- compile-pass and compile-fail fixture projects

### Contract Graph Unit Tests

Use focused graph tests for Trail's compiler-like validation layer.

These tests should exercise graph construction without running the CLI or Hono adapter:

- filesystem routes to route graph
- route path and method conflicts
- path param validation
- schema graph construction
- name registry conflicts
- middleware inheritance order
- URL-less group folders such as `(private)` and `(admin)`
- middleware `requires` / `provides` validation
- route-specific ctx metadata
- stale or inconsistent `.trail/routes.gen.ts` detection

Example:

```txt
routes/middleware.ts
routes/(admin)/middleware.ts
routes/(admin)/users/route.ts
-> resolved path is /users
-> resolved middleware order is global, admin group, users segment, route, method
-> handler ctx includes only fields provided by that chain
```

### Golden and Idempotence Tests

Use golden tests for generated files and formatting stability:

- OpenAPI fixture to generated route files
- generated `schemas.ts`
- generated `.trail/manifest.json`
- generated `.trail/openapi-baseline.json`
- generated `.trail/routes.gen.ts`
- stable imports
- stable ordering
- stable formatting
- generating twice produces no diff

Fixture shape:

```txt
fixtures/
  scaffold-basic/
    input/
      openapi.yaml
    expected/
      routes/users/route.ts
      routes/users/schemas.ts
      .trail/manifest.json
      .trail/openapi-baseline.json
      .trail/routes.gen.ts
```

Test flow:

```txt
run trail scaffold input/openapi.yaml
compare output to expected
run scaffold again
assert no diff
```

### CLI Integration Tests

Use CLI integration tests for command behavior:

- `trail check` exit codes
- `trail build` stops before emit on graph validation failure
- duplicate route diagnostics
- invalid middleware ordering diagnostics
- conflict preview behavior
- unsupported OpenAPI input failures
- baseline update command behavior

Examples:

```txt
trail check exits non-zero on duplicate GET /users
trail build exits before emit when graph validation fails
trail scaffold openapi.txt fails before creating files
```

### Diagnostic Snapshot Tests

Use diagnostic snapshots for framework-aware errors.

Trail's diagnostics are product behavior, not incidental logs. Tests should keep them stable enough for users and CI.

Cover:

- duplicate schema names
- duplicate route path and method
- missing middleware provider
- invalid path params
- bad TypeScript identifiers
- missing `$ref` components
- unsupported v0 OpenAPI constructs
- generated-file ownership or manifest drift

Snapshots should normalize unstable data such as absolute temp paths while preserving:

- issue code
- severity
- file path
- route path and method when available
- schema or operation name when available
- suggested fix

### OpenAPI Drift and Baseline Tests

Use OpenAPI tests for source-to-contract promises:

- generated OpenAPI matches source contracts
- baseline drift detection
- breaking-change reports
- `trail openapi breaking --update-baseline`
- route responses merged with middleware rejects
- validation errors documented where input schemas exist
- security metadata derived from guards where applicable

Examples:

```txt
changed response status from 200 to 201 reports path/method/status
removed POST /users is reported by openapi breaking
openapi breaking --update-baseline writes the accepted baseline
```

### Runtime Request Tests

Use runtime tests for Hono adapter behavior:

- request validation
- response status and body mapping
- response content negotiation
- unsupported request `Content-Type`
- unsupported response `Accept`
- middleware reject behavior
- standard framework error responses
- request identity headers where v0 covers them

The v0 adapter may use Hono `app.request()` internally.

Examples:

```txt
invalid JSON body returns validation error
missing auth header returns 401 from auth middleware
valid request returns success response
```

### Regeneration Safety Tests

Use regeneration tests for stateful file safety:

- preview before writing
- no blind overwrite
- manual edits in generated files detected where possible
- deleted OpenAPI paths do not silently delete source
- manifest missing switches to conservative preview mode
- accepted regeneration updates manifest, baseline, and route metadata consistently

These tests may overlap with CLI and golden tests, but the risk is high enough to track as its own group.

### Configuration and Guardrail Tests

Use configuration tests for framework rules that warn or fail before runtime bugs happen:

- production docs exposure guardrails
- invalid security/header config
- strict mode warning escalation
- environment config validation
- unsafe logging or raw request logging flags
- unsupported production defaults where Trail defines guardrails

These are not route behavior tests. They prove Trail reports unsafe or inconsistent configuration at check, startup, or build boundaries.

## Suggested Minimum v0 Suite

For a v0 proof of concept, the minimum useful suite is:

- type tests for route input, response variants, and middleware ctx
- graph unit tests for route conflicts and middleware ordering
- golden/idempotence tests for scaffold output
- CLI tests for `trail check`, `trail build`, and invalid scaffold input
- OpenAPI drift/baseline tests
- Hono runtime request tests for validation, response mapping, and middleware rejects
- diagnostic snapshots for the main Trail graph errors

## Relationship To User-Facing Test Helpers

This strategy is about Trail's internal test suite.

The user-facing testing helper design remains in `extensibility_and_testing_design.md`. That design covers APIs such as route handler tests, middleware tests, service overrides, and in-memory HTTP tests for application developers.

Trail may use similar infrastructure internally, but the responsibilities are different:

- internal tests prove Trail's framework promises
- user-facing helpers help applications test their own route behavior

## Review

The core testing idea is correct: Trail needs a layered matrix because its promises fail at different layers.

The handoff's original layers are necessary but not quite complete. The missing groups are:

- contract graph unit tests, because graph construction is the reusable core behind `trail check`, `trail build`, generated metadata, and route-specific ctx
- diagnostic snapshot tests, because framework-aware diagnostics are part of the product value
- regeneration safety tests, because Trail's OpenAPI-to-source loop is only trustworthy if it preserves user work
- configuration and guardrail tests, because many Trail failures should happen before request handling

With those additions, the strategy covers the actual shape of Trail: types, graph validation, generation, CLI behavior, OpenAPI alignment, runtime behavior, file safety, and guardrails.
