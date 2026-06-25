# v0 Spec: Check and Build

## Feature

Trail validates projects through `trail check` and builds through `trail build`.

`trail check` is compiler-like validation, not linting. It should report Trail-aware contract, schema, route, and generation problems before TypeScript can only report generic errors.

The reusable unit is Trail graph validation, not the full `trail check` command.

Pipeline:

```txt
inputs
-> parse
-> route graph
-> schema graph
-> middleware graph
-> name registry
-> diagnostics
-> command output
```

## Scope

In v0:

- `trail check` runs Trail contract, schema, and route checks.
- `trail check` runs TypeScript typechecking without emitting JavaScript.
- `trail build` reuses Trail graph validation before build output.
- `trail build` compiles TypeScript to JavaScript only after Trail graph validation passes.
- `trail build` should not require a separate TypeScript `noEmit` pass before TypeScript emit.
- Route-local schemas are the default generated shape.
- OpenAPI component `$ref` schemas keep shared identity.
- Schemas without explicit OpenAPI component identity are not auto-shared.

## Acceptance Cases

```yaml
case: v0_check_runs_graph_validation_and_typecheck
intent: check validates Trail contracts and TypeScript types without emitting JS
input:
  project:
    has_valid_trail_graph: true
action: trail check
expected:
  behavior:
    - Trail graph validation runs
    - TypeScript typecheck runs without emit
    - command exits non-zero on Trail or TypeScript errors
must_not:
  - emit JavaScript output
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
case: v0_build_reuses_graph_validation_then_emits
intent: build avoids redundant noEmit pass while preserving Trail checks
input:
  project:
    has_valid_trail_graph: true
action: trail build
expected:
  behavior:
    - Trail graph validation runs
    - TypeScript compiles to JavaScript
must_not:
  - require a separate TypeScript noEmit pass before TypeScript emit
```

```yaml
case: v0_build_stops_before_emit_on_graph_error
intent: build cannot emit when Trail graph validation fails
input:
  project:
    has_duplicate_route: true
action: trail build
expected:
  behavior:
    - Trail graph validation reports the duplicate route
    - command exits non-zero
must_not:
  - emit JavaScript output after failed Trail validation
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
- Requiring `trail build` to run the full `trail check` CLI before emit.
- Running a redundant `tsc --noEmit` pass inside `trail build`.
- Replacing focused commands such as `trail openapi check` or `trail openapi breaking`.
