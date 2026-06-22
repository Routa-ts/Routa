# v0 Spec: OpenAPI Check

## Feature

Trail checks generated OpenAPI against source contracts and baseline expectations.

## Acceptance Cases

```yaml
case: v0_openapi_check_clean
intent: source contracts generate expected OpenAPI
input:
  files:
    routes/users/route.ts: generated route contract
    routes/users/schemas.ts: generated schemas
    .trail/openapi-baseline.json: committed baseline
action: trail openapi check
expected:
  behavior:
    - command exits successfully
    - no drift reported
```

```yaml
case: v0_openapi_check_reports_drift
intent: changed source contract is visible
input:
  change:
    route response status changes from 200 to 201
  baseline:
    response status is 200
action: trail openapi check
expected:
  behavior:
    - command reports drift
    - report includes path, method, and response status
failure:
  mode: non-zero exit in strict mode
```

```yaml
case: v0_openapi_breaking_reports_removed_method
intent: breaking command detects removed operations
input:
  baseline:
    /users:
      get: listUsers
      post: createUser
  current:
    /users:
      get: listUsers
action: trail openapi breaking
expected:
  behavior:
    - command reports removed POST /users
    - default severity is info unless configured
```

```yaml
case: v0_openapi_update_baseline
intent: accepted current contract can become new baseline
input:
  current_generated_openapi: valid
action: trail openapi breaking --update-baseline
expected:
  behavior:
    - .trail/openapi-baseline.json is replaced with current normalized OpenAPI
    - command reports baseline update
must_not:
  - update baseline silently during normal scaffold unless requested or confirmed
```

## Out of Scope

- Full SDK generation.
- Enforcing deprecation policy.
- Production docs exposure policy.
