# Trail Acceptance Specs

## Purpose

These specs define expected behavior before implementation.

They are written for two readers:

- humans deciding product behavior
- AI agents generating implementation and tests

They are not implementation tests yet. They are acceptance contracts that later tests should follow.

## Format

Each case uses a compact structured format:

```yaml
case: stable_case_id
intent: what this proves
input:
  files: files or contract data involved
action: command or framework action
expected:
  files: generated or changed files
  behavior: observable behavior
must_not:
  - behavior that must never happen
failure:
  mode: expected failure behavior
```

Use stable case ids in future tests, fixtures, docs, and implementation tickets.

## v0 Specs

- [OpenAPI Scaffold](./v0/openapi_scaffold.md)
- [Route Contracts](./v0/route_contracts.md)
- [Business Logic Boundary](./v0/services_boundary.md)
- [Manifest and Baseline](./v0/manifest_and_baseline.md)
- [Regeneration](./v0/regeneration.md)
- [OpenAPI Check](./v0/openapi_check.md)
- [Input Validation](./v0/input_validation.md)
- [Check and Build](./v0/check_and_build.md)

## v1 Specs

- [Middleware Contracts](./v1/middleware_contracts.md)
- [Security Visibility](./v1/security_visibility.md)
- [OpenAPI Evolution](./v1/openapi_evolution.md)
- [Routing Styles](./v1/routing_styles.md)
- [Collections and Caching](./v1/collections_and_caching.md)
- [Runtime and Operations](./v1/runtime_and_operations.md)
- [Extensibility and Testing](./v1/extensibility_and_testing.md)

## Rules

- Specs should describe externally visible behavior.
- Specs should avoid implementation internals unless ownership, safety, or generated output depends on them.
- v0 specs must be concrete enough to build a proof of concept.
- v1 specs may describe target behavior, but should not expand v0 scope.
- When implementation differs from a spec, update the spec or reject the implementation.
