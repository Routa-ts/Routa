# v1 Spec: OpenAPI Evolution

## Feature

Routa supports API evolution through checks, baseline comparison, breaking-change reports, versioning guidance, and deprecation metadata.

## Acceptance Cases

```yaml
case: v1_openapi_breaking_added_required_input
intent: breaking command reports stricter input
input:
  baseline:
    GET /users:
      query:
        status: optional
  current:
    GET /users:
      query:
        status: required
action: routa openapi breaking
expected:
  behavior:
    - reports optional input changed to required
    - includes path and method
```

```yaml
case: v1_openapi_breaking_tighter_auth
intent: stricter auth is a compatibility change
input:
  baseline:
    GET /users: public
  current:
    GET /users: requires auth
action: routa openapi breaking
expected:
  behavior:
    - reports tighter authentication requirement
```

```yaml
case: v1_deprecation_headers_enabled
intent: deprecation metadata can emit lifecycle headers
input:
  route:
    deprecation:
      sunset: "2027-01-01"
      replacement: "/v2/users"
  config:
    lifecycleHeaders: true
action: handle request
expected:
  behavior:
    - response includes Deprecation, Sunset, and Link headers where configured
    - OpenAPI marks operation deprecated
```

## Out of Scope for v0

- Enforcing version retirement windows.
- Header/media-type versioning abstraction.
