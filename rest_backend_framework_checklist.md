# REST Backend Framework Checklist

Use this checklist to mark what the framework already covers and identify what is missing.

## Core REST Contract

- [x] Resource-oriented route design
- [x] Nested resources
- [x] Collection routes vs item routes
- [x] Route params
- [ ] Query params
- [x] Wildcard route rules
- [ ] Correct `GET` semantics
- [ ] Correct `HEAD` semantics
- [ ] Correct `POST` semantics
- [ ] Correct `PUT` semantics
- [ ] Correct `PATCH` semantics
- [ ] Correct `DELETE` semantics
- [ ] Correct `OPTIONS` semantics
- [ ] Correct HTTP status code behavior
- [ ] Request parser
- [ ] Response builder
- [x] Middleware or interceptor pipeline
- [x] Route handlers or controllers
- [x] Per-route metadata
- [ ] Abort or cancellation handling
- [ ] Graceful shutdown
- [ ] JSON-first serialization
- [ ] Pluggable body parsers
- [ ] Content negotiation through `Accept`
- [ ] Content negotiation through `Content-Type`
- [ ] Reject unsupported request media types with `415 Unsupported Media Type`
- [ ] Reject unsupported response media types with `406 Not Acceptable`
- [x] Validate path params
- [x] Validate query params
- [ ] Validate headers
- [ ] Validate cookies
- [x] Validate request bodies
- [x] Support syntactic validation
- [ ] Support semantic validation
- [x] Strong typing or schema-based validation
- [ ] Request body size limits
- [ ] Reject unknown or illegal fields when configured
- [x] Standard error shape
- [ ] Validation errors with field paths
- [ ] Stable framework error codes
- [ ] Hide stack traces and internal details in production
- [ ] Support or align with RFC 9457 `application/problem+json`

## API Design Features

- [x] Generate OpenAPI from routes and schemas
- [ ] Support spec-first OpenAPI workflows
- [x] Document request bodies in OpenAPI
- [x] Document response bodies in OpenAPI
- [x] Document status codes in OpenAPI
- [ ] Document auth schemes in OpenAPI
- [ ] Document examples in OpenAPI
- [ ] Document tags in OpenAPI
- [ ] Use OpenAPI for generated docs
- [ ] Use OpenAPI for testing or contract checks
- [ ] Use OpenAPI for SDK generation
- [ ] Built-in pagination primitives
- [ ] Cursor pagination
- [ ] Offset pagination
- [ ] Stable ordering requirements for pagination
- [ ] Pagination `next` links or tokens
- [ ] Pagination `prev` links or tokens
- [ ] Filtering conventions
- [ ] Sorting conventions
- [ ] Allowlisted filter fields
- [ ] Sparse fieldsets or response projections
- [ ] Protection against unrestricted arbitrary query execution
- [ ] Backward-compatible API changes by default
- [ ] Deprecation metadata
- [ ] Deprecation headers
- [ ] Strategy for breaking changes
- [ ] Versioning strategy
- [ ] Cache-Control support
- [ ] ETag support
- [ ] Last-Modified support
- [ ] `If-None-Match` support
- [ ] `If-Match` support for optimistic concurrency

## Security

- [x] Authentication abstraction
- [ ] Bearer token support
- [ ] API key support for suitable cases
- [ ] Session or cookie support if browser APIs are a target
- [x] Per-route authorization hooks
- [ ] Object-level authorization support
- [x] Function-level authorization support
- [ ] Field or property-level authorization support
- [ ] Avoid relying only on controller-level authorization checks
- [ ] Mitigation for broken object-level authorization
- [ ] Mitigation for broken authentication
- [ ] Mitigation for broken object property-level authorization
- [ ] Mitigation for unrestricted resource consumption
- [ ] Mitigation for broken function-level authorization
- [ ] Mitigation for unrestricted access to sensitive business flows
- [ ] SSRF protection
- [ ] Security misconfiguration safeguards
- [ ] Safe consumption of third-party APIs
- [ ] Per-IP rate limits
- [ ] Per-token rate limits
- [ ] Per-route rate limits
- [ ] Request timeout limits
- [ ] Concurrency limits
- [ ] Clear `429 Too Many Requests` behavior
- [ ] Explicit CORS configuration
- [ ] No wildcard CORS credentials
- [ ] Allowed CORS origins
- [ ] Allowed CORS methods
- [ ] Allowed CORS headers
- [ ] CORS preflight handling
- [ ] Security headers for browser-consumed APIs
- [ ] HTTPS assumption
- [ ] No stack traces in production responses
- [ ] No sensitive data in URLs
- [ ] Header normalization
- [ ] HTTP method allowlists
- [ ] Safe request parsers
- [ ] SSRF-safe outbound HTTP helpers if outbound helpers are included

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
- [x] Typed handlers
- [x] Schema integration
- [x] Middleware composition
- [ ] Dependency injection or service container
- [ ] Testing helpers
- [ ] Good defaults
- [x] Escape hatches for advanced use cases
- [ ] Plugin or module system
- [ ] Replaceable logger
- [ ] Replaceable validator
- [ ] Replaceable serializer
- [ ] Replaceable auth provider
- [ ] Startup lifecycle hooks
- [ ] Shutdown lifecycle hooks
- [ ] Request start lifecycle hooks
- [ ] Request end lifecycle hooks
- [x] Error lifecycle hooks
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
- [ ] Authentication hooks
- [x] Authorization hooks
- [ ] Rate limits
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
