# v1 Spec: Runtime and Operations

## Feature

Trail provides operational boundary behavior such as request identity, structured logs, health/readiness, env validation, and safe defaults.

## Acceptance Cases

```yaml
case: v1_request_id_generated
intent: every request has a Trail-generated request id
input:
  request: GET /users
action: handle request
expected:
  behavior:
    - ctx.core.requestId exists
    - response includes x-request-id by default
```

```yaml
case: v1_correlation_id_preserved_when_valid
intent: upstream correlation id is preserved, not invented
input:
  request:
    headers:
      x-correlation-id: valid-id
action: handle request
expected:
  behavior:
    - ctx.core.correlationId is valid-id
    - response includes x-correlation-id
```

```yaml
case: v1_health_liveness_only
intent: health endpoint does not check dependencies
input:
  database: unavailable
action: GET /health
expected:
  behavior:
    - response is 200 while process can serve HTTP
must_not:
  - fail health because database is down
```

```yaml
case: v1_readiness_checks_dependencies
intent: readiness decides whether process should receive traffic
input:
  readiness_checks:
    database: fail
action: GET /ready
expected:
  behavior:
    - response is 503
    - production response hides dependency details
```

```yaml
case: v1_env_validation_blocks_startup
intent: invalid config prevents partial startup
input:
  env:
    DATABASE_URL: missing
action: start app
expected:
  behavior:
    - startup fails before serving traffic
    - secret values are redacted in errors
```

## Out of Scope for v0

- Full observability adapters.
- Full deployment lifecycle hooks.
