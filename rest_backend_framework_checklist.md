# REST Backend Framework Checklist

Use this checklist to mark what the framework already covers and identify what is missing.

## Core REST Contract

- [x] Resource-oriented route design
- [x] Nested resources
- [x] Collection routes vs item routes
- [x] Route params
- [x] Query params
- [x] Wildcard route rules
- [x] Correct `GET` semantics
- [x] Correct `HEAD` semantics
- [x] Correct `POST` semantics
- [x] Correct `PUT` semantics
- [x] Correct `PATCH` semantics
- [x] Correct `DELETE` semantics
- [x] Correct `OPTIONS` semantics
- [x] Correct HTTP status code behavior
- [x] Request parser
- [x] Response builder
- [x] Middleware or interceptor pipeline
- [x] Route handlers or controllers
- [x] Per-segment route file metadata (one `route.ts` per URL segment, not one file per HTTP verb)
- [x] Parent collection segment alongside dynamic child segments (`users/route.ts` + `users/$id/route.ts`, collection `post` → `201` on parent)
- [x] Abort or cancellation handling
- [ ] Graceful shutdown
- [x] JSON-first serialization
- [ ] Pluggable body parsers
- [x] Content negotiation through `Accept`
- [x] Content negotiation through `Content-Type`
- [x] Reject unsupported request media types with `415 Unsupported Media Type`
- [x] Reject unsupported response media types with `406 Not Acceptable`
- [x] Validate path params
- [x] Validate query params
- [x] Validate headers
- [x] Validate cookies
- [x] Validate request bodies
- [x] Support syntactic validation
- [ ] Support semantic validation
- [x] Strong typing or schema-based validation
- [x] Request body size limits
- [ ] Reject unknown or illegal fields when configured
- [x] Standard error shape
- [x] Validation errors with field paths
- [x] Stable framework error codes
- [x] Hide stack traces and internal details in production
- [x] Support or align with RFC 9457 `application/problem+json`

## API Design Features

- [x] Generate OpenAPI from routes and schemas
- [x] Support spec-first OpenAPI workflows
- [x] Document request bodies in OpenAPI
- [x] Document response bodies in OpenAPI
- [x] Document status codes in OpenAPI
- [x] Document auth schemes in OpenAPI
- [x] Document examples in OpenAPI
- [x] Document tags in OpenAPI
- [x] Use OpenAPI for generated docs
- [x] Use OpenAPI for testing or contract checks
- [x] Use OpenAPI for SDK generation
  Decision note: emit SDK-ready OpenAPI for external generators; no built-in SDK generator in v1.
- [x] Built-in pagination primitives
- [x] Cursor pagination
- [x] Offset pagination
- [x] Stable ordering requirements for pagination
- [x] Pagination `next` links or tokens
- [x] Pagination `prev` links or tokens
- [x] Filtering conventions
- [x] Sorting conventions
- [x] Allowlisted filter fields
  Decision note: allowlisted filters are declared by the route query schema; Trail does not add a separate filter DSL in v1.
- [x] Sparse fieldsets or response projections
- [x] Protection against unrestricted arbitrary query execution
- [x] Backward-compatible API changes by default
  Decision note: Trail defaults to additive evolution posture through `trail openapi breaking` baseline comparison, not runtime enforcement.
- [x] Deprecation metadata
- [x] Deprecation headers
- [x] Strategy for breaking changes
- [x] Versioning strategy
- [x] Cache-Control support
- [x] ETag support
- [x] Last-Modified support
- [x] `If-None-Match` support
- [x] `If-Match` support for optimistic concurrency

## Security

- [x] Authentication abstraction
- [x] Bearer token support
- [x] API key support for suitable cases
- [x] Session or cookie support if browser APIs are a target
- [x] Per-route authorization guard middleware and policy callbacks
- [x] Object-level authorization support
- [x] Function-level authorization support
- [x] Field or property-level authorization support
- [x] Avoid relying only on controller-level authorization checks
- [ ] Mitigation for broken object-level authorization
- [ ] Mitigation for broken authentication
- [ ] Mitigation for broken object property-level authorization
- [ ] Mitigation for unrestricted resource consumption
- [ ] Mitigation for broken function-level authorization
- [ ] Mitigation for unrestricted access to sensitive business flows
- [x] SSRF protection for Trail-managed outbound helpers
- [x] Security misconfiguration safeguards
- [x] Safe consumption of third-party APIs through `safeFetch`
- [x] Per-IP rate limits
- [x] Per-auth identity rate limits
- [x] Implicit per-route rate-limit bucket scoping
- [x] Request timeout limits
- [x] Concurrency limits
- [x] Clear `429 Too Many Requests` behavior
- [x] Explicit CORS configuration
- [x] No wildcard CORS credentials
- [x] Allowed CORS origins
- [x] Allowed CORS methods
- [x] Allowed CORS headers
- [x] CORS preflight handling
- [x] Security headers for browser-consumed APIs
- [x] HTTPS assumption
- [ ] No stack traces in production responses
- [x] Guardrails to discourage sensitive data in URLs
- [x] Header normalization
- [ ] HTTP method allowlists
- [x] Safe request parsers
- [x] SSRF-safe outbound HTTP helpers through `safeFetch`

## Operations

- [ ] Structured logs
- [x] Request IDs
- [ ] Correlation IDs
- [ ] Request duration metrics
- [ ] Active request metrics
- [ ] Status code metrics
- [ ] Error rate metrics
- [ ] Tracing hooks
- [ ] OpenTelemetry semantic convention alignment
- [ ] Health endpoint
- [ ] Readiness endpoint
- [ ] Startup or liveness semantics
- [ ] Dependency health checks
- [ ] Security event logs
- [ ] Token, secret, and PII redaction in logs
- [ ] Log injection protection
- [ ] Environment-based configuration
- [ ] No hardcoded secrets
- [ ] Config validation at startup
- [ ] Separate build, release, and run concerns

## Framework Architecture

- [x] Simple route declaration
- [x] Resource route files (`defineRoute` with per-method `createRoute` per URL segment)
- [x] Typed handlers
- [x] Schema integration
- [x] Middleware composition
- [ ] Dependency injection or service container
- [ ] Testing helpers
- [x] Good defaults
- [x] Escape hatches for advanced use cases
- [ ] Plugin or module system
- [ ] Replaceable logger
- [ ] Replaceable validator
- [ ] Replaceable serializer
- [x] Replaceable auth provider
- [ ] Startup lifecycle hooks
- [ ] Shutdown lifecycle hooks
- [ ] Request start lifecycle hooks
- [ ] Request end lifecycle hooks
- [ ] Error lifecycle hooks
- [ ] Framework-level metadata registry
- [ ] Unit testing route handlers
- [ ] Integration testing HTTP requests
- [ ] Contract testing against OpenAPI
- [ ] Security regression tests
- [ ] Error shape snapshot tests
- [ ] Middleware ordering tests
- [ ] Stateless process model
- [ ] Port binding
- [ ] Fast startup
- [ ] Backing services accessed through config
- [ ] Generated API docs
- [ ] Route reference documentation
- [ ] Error catalog
- [ ] Auth guide
- [ ] Middleware or plugin guide
- [ ] Deployment guide
- [ ] Security recommendations

## Version 1 Priority

- [x] Routing
- [x] Middleware
- [x] Request and response lifecycle
- [x] Validation
- [x] Standardized errors
- [x] OpenAPI
- [x] Authentication provider/strategy hooks
- [x] Authorization guard middleware and policy callbacks
- [x] Rate limits
- [ ] Structured logging
- [ ] Health endpoint
- [ ] Readiness endpoint
- [ ] Test helpers

## Later Priority

- [ ] Cache control
- [ ] Advanced versioning
- [ ] Plugin system
- [ ] Tracing
- [ ] Deeper deployment features
