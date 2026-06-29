# Framework Review Groups

Use these groups to review the remaining design decisions one conversation at a time. Each group is sized to end with one new decision document and a checklist update.

## Current Product Direction

Routa v0 is schema-source-first:

- Zod schemas are the v0 schema runtime.
- Hono is the v0 runtime adapter.
- OpenAPI `.yaml` and `.json` can scaffold source.
- Route contracts generate OpenAPI for docs and checks.
- Security configuration is made visible and documented; Routa does not solve application security.

The v0 validation scope lives in:

- `v0_requirements.md`
- `specs/README.md`

## Completed Review Groups

### Group 1: HTTP Contract Surface

Completed. Consolidated decisions and checklist alignment are in:

- `http_contract_group1_wrapup.md`

### Group 2: Auth and API Security

Completed. Consolidated decisions and checklist alignment are in:

- `security_design.md`

### Group 3: OpenAPI and API Evolution

Completed. Consolidated decisions and checklist alignment are in:

- `openapi_and_versioning_design.md`

Deferred for a later hardening pass:

- Broken authentication and broken authorization mitigation mapping.
- Unrestricted resource consumption mitigation beyond the rate-limit, timeout, and concurrency model.
- Unrestricted access to sensitive business flows.
- HTTP method allowlists as a security-specific control.

### Group 4: Collections and REST Query Features

Completed. Consolidated decisions and checklist alignment are in:

- `collections_and_caching_design.md`

### Group 5: Runtime, Observability, and Deployment

Completed. Consolidated decisions and checklist alignment are in:

- `runtime_and_operations_design.md`

Completed parts:

- Part 5.1: Structured logging and request identity
- Part 5.2: Metrics and tracing
- Part 5.3: Health, readiness, and liveness
- Part 5.4: Log redaction and log injection protection
- Part 5.5: Environment config, secrets, and startup validation
- Part 5.6: Deployment runtime model
- Part 5.7: Lifecycle hooks

Remaining topics:

- None

### Group 6: Extensibility, Testing, and DX

Completed. Consolidated decisions and checklist alignment are in:

- `extensibility_and_testing_design.md`

Completed parts:

- Part 6.1: Services and dependency injection
- Part 6.2: Validators, serializers, and metadata registry
- Part 6.3: Integrations instead of plugins
- Part 6.4: Testing helpers
- Part 6.5: Security testing and documentation DX

Remaining topics:

- None

## Remaining Review Groups

- None

## Review Rule

Only check a box in the main checklist when the current design explicitly defines the behavior or clearly rejects an option.
