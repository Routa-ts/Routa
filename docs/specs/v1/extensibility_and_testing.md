# v1 Spec: Extensibility and Testing

## Feature

Routa supports optional services, test helpers, generated integrations, and route reference tooling without a broad plugin system.

Routa does not generate application business logic services. Any service override or dependency wiring is for developer-owned code.

## Acceptance Cases

```yaml
case: v1_service_override_test_only
intent: tests can replace configured services safely
input:
  app_services:
    email: realEmailService
  test_override:
    email: fakeEmailService
action: createTestApp
expected:
  behavior:
    - route receives fake email service in test
    - production service registry is not mutated
```

```yaml
case: v1_duplicate_service_key_fails
intent: service scopes cannot shadow each other accidentally
input:
  app_services:
    users: appUsers
  method_services:
    users: methodUsers
action: compile or start app
expected:
  behavior:
    - duplicate key is rejected
```

```yaml
case: v1_http_integration_test_no_server
intent: test helper can run request in memory
input:
  app: createTestApp
  request:
    method: POST
    path: /users
action: app.request
expected:
  behavior:
    - returns standard Response
    - no network server is required
```

```yaml
case: v1_integration_preview_first
intent: generated integrations do not surprise-edit projects
input:
  command: routa auth
action: run integration command
expected:
  behavior:
    - previews files to create/modify
    - previews package installs
    - stops on conflicts before writing
must_not:
  - silently overwrite user code
  - generate application business logic services by default
```

## Out of Scope for v0

- Runtime plugin lifecycle.
- Third-party plugin registration API.
- Broad metadata registry mutation API.
