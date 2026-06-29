# v1 Spec: Middleware Contracts

## Feature

Middleware declares requirements, provided ctx, early rejects, HTTP input it reads, and OpenAPI-visible metadata.

## Acceptance Cases

```yaml
case: v1_middleware_requires_previous_provider
intent: middleware order is type-checked
input:
  middleware:
    - requirePermissions:
        requires: auth
    - requireAuth:
        provides: auth
action: compile route
expected:
  behavior:
    - TypeScript or Routa check reports invalid order
must_not:
  - allow handler to assume ctx.state.auth when not provided
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
case: v1_middleware_provided_state_typed
intent: handler receives provided state without optional chaining
input:
  middleware:
    loadTenant:
      provides: tenant
action: typecheck handler
expected:
  behavior:
    - ctx.state.tenant is typed as present
```

## Out of Scope for v0

Broad middleware integrations are not required in v0 beyond the minimal typed pipeline, folder inheritance, and route-specific ctx proof.
