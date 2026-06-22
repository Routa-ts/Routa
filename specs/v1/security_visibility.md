# v1 Spec: Security Visibility

## Feature

Trail makes security configuration visible, typed, and documented. Trail does not solve application security.

## Acceptance Cases

```yaml
case: v1_security_auth_requirement_visible
intent: configured auth guard appears in route metadata and OpenAPI
input:
  route:
    middleware:
      - requireAuth
action: generate OpenAPI
expected:
  behavior:
    - OpenAPI security requirement is emitted
    - standard 401 response is documented
    - route reference shows auth requirement
must_not:
  - claim auth logic is proven secure
```

```yaml
case: v1_security_permission_visible
intent: authorization requirement is documented without owning policy logic
input:
  route:
    middleware:
      - requirePermission: users.read
action: generate route reference
expected:
  behavior:
    - route reference includes required capability users.read
    - OpenAPI may include x-trail-authz metadata
must_not:
  - serialize internal policy logic as framework-owned truth
```

```yaml
case: v1_security_openapi_scaffold_placeholder
intent: OpenAPI security metadata becomes safe placeholder wiring
input:
  openapi:
    security:
      - bearerAuth: []
action: trail scaffold openapi.yaml
expected:
  behavior:
    - generated route includes auth placeholder or middleware hook
    - generated output warns that app must implement credential validation
must_not:
  - generate fake secure auth logic
```

## Required Language

Docs and generated warnings must say:

- Trail makes security visible.
- Application owns security correctness.
- Configuration is not proof of security.
