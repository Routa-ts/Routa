# v0 Spec: Check and Build

## Feature

Trail validates projects through `trail check` and builds through `trail build`.

`trail check` is compiler-like validation, not linting. It should report Trail-aware contract, schema, route, and generation problems before TypeScript can only report generic errors.

## Scope

In v0:

- `trail check` runs Trail contract, schema, and route checks.
- `trail check` runs TypeScript typechecking without emitting JavaScript.
- `trail build` runs `trail check` before build output.
- `trail build` compiles TypeScript to JavaScript only after checks pass.
- Route-local schemas are the default generated shape.
- OpenAPI component `$ref` schemas keep shared identity.
- Schemas without explicit OpenAPI component identity are not auto-shared.

## Acceptance Cases

```yaml
case: v0_check_runs_trail_and_typescript_checks
intent: project validation catches Trail and TypeScript errors
input:
  files:
    routes/users/route.ts: route contract source
    routes/users/schemas.ts: route-local schemas
action: trail check
expected:
  behavior:
    - Trail validates route contracts, schema names, imports, route conflicts, and generated-file state where detectable
    - TypeScript typechecking runs without emitting JavaScript
    - command exits non-zero on Trail or TypeScript errors
must_not:
  - emit JavaScript build output
```

```yaml
case: v0_check_reports_schema_name_conflict
intent: route-local schema conflicts produce framework-aware diagnostics
input:
  files:
    routes/admin/users/schemas.ts:
      exports:
        - UserResponse
        - UserResponse
action: trail check
expected:
  behavior:
    - command reports duplicate schema name
    - diagnostic includes file path and schema name
    - diagnostic suggests a stable contract-purpose name
failure:
  mode: non-zero exit code
must_not:
  - rely only on TypeScript redeclaration errors
```

```yaml
case: v0_build_runs_check_before_emit
intent: build cannot emit when checks fail
input:
  project:
    has_trail_check_error: true
action: trail build
expected:
  behavior:
    - command runs Trail project checks before TypeScript emit
    - command exits non-zero
must_not:
  - emit JavaScript build output
  - run TypeScript emit after check failure
```

```yaml
case: v0_build_emits_after_check_passes
intent: successful build proves project checks passed first
input:
  project:
    has_trail_check_error: false
    has_typescript_error: false
action: trail build
expected:
  behavior:
    - command runs the same validation as trail check
    - command compiles TypeScript to JavaScript
    - command exits successfully
```

```yaml
case: v0_check_preserves_route_local_schema_default
intent: inline operation schemas stay route-local unless OpenAPI declares shared component identity
input:
  openapi:
    paths:
      /auth/me:
        get:
          operationId: getCurrentUser
          responses:
            "200":
              schema: inline object
      /admin/users:
        post:
          operationId: createUser
          requestBody:
            schema: inline object
    components:
      schemas:
        SharedUser:
          type: object
action: trail check
expected:
  behavior:
    - inline operation schemas are expected as route-local schemas
    - explicit component refs keep shared schema identity
    - generated names prefer contract-purpose names such as GetCurrentUserResponse and CreateUserBody
must_not:
  - auto-share inline schemas only because their shapes match
```

## Required Diagnostics

`trail check` should report:

- issue code
- severity
- file path
- route path and method when available
- schema or operation name when available
- short fix suggestion when possible

## Out of Scope

- Emitting JavaScript from `trail check`.
- Building production bundles without first passing `trail check`.
- Replacing focused commands such as `trail openapi check` or `trail openapi breaking`.
