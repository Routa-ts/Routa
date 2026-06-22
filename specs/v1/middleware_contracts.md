# v1 Spec: Middleware Contracts

## Feature

Middleware declares requirements, state guarantees, early rejects, and OpenAPI-visible metadata.

## Acceptance Cases

```yaml
case: v1_middleware_requires_previous_guarantee
intent: middleware order is type-checked
input:
  middleware:
    - requirePermissions:
        requires: auth
    - requireAuth:
        guarantees: auth
action: compile route
expected:
  behavior:
    - TypeScript or Trail check reports invalid order
must_not:
  - allow handler to assume ctx.state.auth when not guaranteed
```

```yaml
case: v1_middleware_rejects_documented
intent: middleware early responses appear in OpenAPI
input:
  middleware:
    requireAuth:
      rejects:
        missingCredentials: 401
  route:
    responses:
      success: 200
action: generate OpenAPI
expected:
  behavior:
    - OpenAPI includes 200 and 401 responses
    - runtime variants remain type-based
```

```yaml
case: v1_middleware_state_guarantee_typed
intent: handler receives guaranteed state without optional chaining
input:
  middleware:
    loadTenant:
      guarantees: tenant
action: typecheck handler
expected:
  behavior:
    - ctx.state.tenant is typed as present
```

## Out of Scope for v0

Full middleware type graph validation is not required in v0 beyond minimal proof.
