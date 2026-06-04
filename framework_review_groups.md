# Framework Review Groups

Use these groups to review the remaining design decisions one conversation at a time. Each group is sized to end with one new decision document and a checklist update.

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

## Remaining Review Groups

### Group 6: Extensibility, Testing, and DX

Topics to decide:

- Dependency injection or service container
- Testing helpers
- Good defaults
- Plugin or module system
- Replaceable logger
- Replaceable validator
- Replaceable serializer
- Replaceable auth provider
- Framework metadata registry
- Unit test helpers
- Integration test helpers
- OpenAPI contract tests
- Security regression tests
- Error snapshot tests
- Middleware ordering tests
- Route reference docs
- Error catalog
- Auth guide
- Middleware or plugin guide
- Deployment guide
- Security recommendations

Suggested file:

- `extensibility_and_testing_design.md`

## Review Rule

Only check a box in the main checklist when the current design explicitly defines the behavior or clearly rejects an option.
