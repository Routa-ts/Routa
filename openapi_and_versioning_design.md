# OpenAPI and API Evolution Design (Group 3)

## Scope

This document records decisions for Group 3 in small parts.

## Part 3.1: OpenAPI Source Model and Contract Metadata

### Decisions

- Trail is schema-source-first.
- Trail supports both source-to-OpenAPI generation and OpenAPI-to-source scaffolding.
- Trail's normal application source of truth is the schema-backed route contract system:
  - route contracts
  - schemas
  - middleware contracts
  - guard metadata
  - global errors
- Trail v0 accepts OpenAPI `.yaml` and `.json` input for scaffolding.
- Trail v0 generates Zod schemas only.
- Trail supports spec-first workflows for AI-assisted and contract-driven teams:
  - `scaffold`
  - `check`
  - `diff`
- `defineRoute` is the main route authoring surface for OpenAPI-relevant contract data.
- Schema-level OpenAPI metadata from Zod `.openapi(...)` is first-class.
- Users should not need to declare the same contract information in multiple places.

### OpenAPI-to-Source v0

Trail v0 can scaffold source from OpenAPI:

```txt
openapi.yaml/json
-> Zod schemas
-> resource route files
-> typed response variants
-> handler stubs
```

The scaffolded source is reviewed, committed, and edited like normal application code. Trail should not silently overwrite user-authored business logic.

Scaffolding rules:

- Preview generated file changes before writing.
- Preserve existing handler bodies by default.
- Stop on conflicts unless the user explicitly chooses a conflict path.
- Prefer stable names for schemas, routes, response variants, and operation ids.
- Emit warnings for weak or ambiguous OpenAPI input.
- Treat AI-generated OpenAPI as input that must be validated and reviewed, not as trusted truth.

OpenAPI input quality checks should cover at least:

- Missing or duplicate `operationId`.
- Missing schemas for request or response bodies.
- Ambiguous same-status responses.
- Missing path parameter schemas.
- Unsupported media types for v0.
- Names that cannot produce stable TypeScript identifiers.
- Security metadata that cannot map cleanly to Trail middleware placeholders.

### Route Metadata

- Tags are optional.
- If tags are omitted, Trail defaults to the top-level folder name.
- Routes may explicitly override tags when needed.
- Examples should come primarily from schema `.openapi(...)` metadata.
- Route-level example metadata may be added when schema metadata is not sufficient.

### Security Scheme Model

- Trail supports a global OpenAPI security scheme registry.
- Per-route security requirements should be derived primarily from guards and route configuration.
- Trail should support simple security declarations for common schemes and richer declarations where needed, especially for OAuth-style scopes.

### Auth and Authz Boundary

- OpenAPI `security` documents the authentication mechanism, such as:
  - bearer token
  - session/cookie
  - API key
  - OAuth2
- Trail should not prescribe one authorization structure for every application.
- Applications define their own authorization vocabulary and policy model, including roles, permissions, scopes, or custom policy concepts.
- Trail documents required capabilities at the route boundary, but does not attempt to encode full internal authorization logic as framework-owned semantics.

### Guard-Driven OpenAPI

- Guards are the base truth for auth and authz documentation.
- `requireAuth()` contributes authentication requirements and related `401` responses.
- `requirePermission(...)` contributes required capability metadata and related `403` responses.
- `authorizeResource(...)` should also emit the required capability or action by default.
- Route-level metadata may append explanation text, but should not override guard-derived auth or authz requirements.
- OpenAPI should document required authentication and required action/capability, but should not attempt to serialize internal resource policy logic.

### Middleware Contract and OpenAPI Contribution

- Middleware remains part of Trail's normal contract system.
- Middleware contract fields should include:
  - `requires`
  - `provides`
  - `guarantees`
  - `input`
  - `rejects`
  - `run`
- Trail should derive OpenAPI from the normal middleware contract rather than from duplicated OpenAPI-only declarations.
- Custom middleware should be able to contribute public contract metadata automatically through the same Trail-standard structures used elsewhere.

### Middleware Input Shape

- Middleware `input` should support:
  - `headers`
  - `query`
  - `params`
  - `cookies`
  - `body` when needed
- Middleware input should follow the same general input structure family used by route contracts.
- Headers should be declared in `input.headers`, not inside an OpenAPI-only block.

### Middleware OpenAPI Field

- Middleware may include a minimal `openapi` field only for extra documentation metadata.
- Middleware `openapi` should be limited to:
  - `description`
  - `extensions`
- Core contract concerns such as input, rejects, and security should not be redefined inside `openapi`; Trail should infer those from the main middleware contract and guard configuration.

### OpenAPI Extensions for Authz

- Trail may emit vendor extension metadata for required capabilities.
- This metadata should stay generic rather than forcing one authorization model.
- A generic extension such as `x-trail-authz` is preferred over a permission-only name.
- This extension may expose required actions or capabilities for documentation and tooling, while leaving application policy structure fully developer-owned.

## Part 3.2: OpenAPI Outputs, Docs, Checks, and SDK Boundary

### Decisions

- Trail emits `openapi.json` by default.
- The OpenAPI output path should be configurable.
- Trail should support built-in documentation UI.
- The default documentation renderer is `Scalar`.
- `Swagger UI` is supported as an optional renderer.
- Switching renderers should be configuration-based rather than architectural.
- Documentation should be enabled by default in development.
- Documentation should require explicit enablement in production.

### Docs Exposure and Guardrails

- Production exposure guardrails should cover both:
  - documentation UI
  - raw `openapi.json`
- If production OpenAPI exposure is enabled, Trail should require explicit exposure intent or warn by default.
- Exposure intent should allow decisions such as:
  - audience: `public` or `internal`
  - protected: `true` or `false`
- Trail should not force one specific authentication or protection implementation for docs exposure.
- `--strict` should escalate production OpenAPI exposure warnings to failures.

### Renderer Configuration

- Shared documentation configuration should live in a common docs config block.
- Renderer-specific configuration should live under nested renderer keys such as:
  - `docs.scalar`
  - `docs.swagger`
- Trail should use renderer library defaults when the user does not configure renderer-specific options.
- Trail should use upstream public configuration types when those types are available and stable.
- If upstream renderer config typing is missing or unstable, Trail should support a documented subset of known-good options.

### Contract Checks

- `trail check` should be the top-level project validation command.
- `trail openapi check` should be a built-in CLI command.
- Both commands should be easy to run in CI.
- Both commands should return a non-zero exit code on failure.
- `trail check` should include Trail contract/schema/route checks and TypeScript typechecking without emitting JavaScript.
- `trail build` should reuse Trail graph validation before TypeScript emit and fail without emitting when graph validation fails.
- `trail build` should not require a redundant `tsc --noEmit` pass before TypeScript emit.
- Default check severity should favor warnings for quality issues.
- `--strict` should escalate configured warnings to failures.

### Check Scope

- `trail openapi check` should focus on:
  - drift between generated and provided or committed spec
  - contract quality
- `trail check` may include relevant OpenAPI checks, but it is broader than OpenAPI drift and quality.

For v0, checks should focus on:

- generated OpenAPI matches route contracts
- scaffold input quality for `.yaml` and `.json`
- unsupported v0 features
- stable route/schema/operation naming

### Contract Quality Checks

- Trail should warn about missing tags.
- Trail should warn about missing examples.
- Trail should warn about missing security metadata where expected.
- Trail should warn about duplicate or conflicting `operationId` values.
- Trail should warn about invalid or inconsistent contract metadata that degrades documentation or tooling quality.

### `operationId`

- Trail should auto-generate `operationId` by default.
- Route metadata may override the generated `operationId`.
- Trail should warn about duplicate or conflicting generated or overridden `operationId` values.
- Teams may enforce stricter `operationId` policy through `trail openapi check --strict`.

### SDK Generation Boundary

- Trail should not own full SDK generation in v1.
- Trail should produce clean OpenAPI output that works well with external SDK generators.
- Trail should document recommended SDK generation workflows.
- Trail v1 should aim to be SDK-ready rather than ship a built-in SDK generator.

### Scope Boundary

- Trail owns:
  - OpenAPI spec generation
  - documentation serving
  - contract checks
- Trail does not own full SDK generation in v1.

## Part 3.3: Versioning Strategy and Breaking-Change Analysis

### Decisions

- Trail recommends path-based API versioning.
- First-class versioning support in v1 is path-based only.
- Versioning should be route and folder based rather than group-alias based.
- Versioned APIs should be organized through route folders such as:
  - `routes/v1/tasks/route.ts`
  - `routes/v2/tasks/route.ts`
- Multiple live API versions should be supported through versioned route folders.

### Other Versioning Styles

- Header-based versioning and media-type versioning remain possible.
- Trail's existing header validation, content negotiation, and route contract features are sufficient for manual implementations of those styles.
- Trail does not define a first-class abstraction for non-path versioning styles in v1.
- Documentation should recommend path-based versioning while making it clear that teams may implement other strategies manually.

### `trail openapi check`

- `trail openapi check` should focus on:
  - drift
  - contract quality
  - docs and spec quality rules
- `trail openapi check` should not own breaking-change analysis.

### Breaking-Change Command

- Breaking-change analysis should use a separate command:
  - `trail openapi breaking`
- The breaking-change command should compare compatibility and report breaking changes only.
- The breaking-change command should compare the current generated OpenAPI output against a stored baseline snapshot file.
- Trail should use a fixed default baseline path.
- Trail should also allow an explicit alternate baseline path through a CLI flag.
- If no baseline file exists, `trail openapi breaking` should instruct the developer to create one.
- The command should support baseline creation and replacement through:
  - `trail openapi breaking --update-baseline`
- After reporting changes, the command should tell the developer how to accept the current contract as the new baseline.
- Default breaking-change severity should be `info`.
- Teams should be able to raise breaking-change severity as an API stabilizes.
- The command should support:
  - `--severity=info|warn|error`

### Breaking-Change Scope

- Trail should report removed paths.
- Trail should report removed methods.
- Trail should report added required input.
- Trail should report optional input changed to required.
- Trail should report incompatible request schema narrowing.
- Trail should report removed response variants, statuses, or media types.
- Trail should report incompatible response schema changes.
- Trail should report tighter authentication requirements.
- Trail should report route moves or renames that break clients.

### Evolution Posture

- Trail should recommend additive API evolution by default.
- Trail should express this posture through baseline comparison tooling rather than through runtime enforcement.
- Trail should not block intentional breaking changes, but it should make them explicit.
- This compatibility posture should work whether or not the application uses explicit API versioning.
- If explicit API versioning is used, introducing a new version should be the recommended path for incompatible changes.

### Lifecycle Posture

- Trail should support lifecycle metadata and version status fields for teams that want them.
- Trail should not enforce overlap windows or retirement policy.
- Detailed deprecation behavior belongs in the deprecation part of this group rather than in the versioning strategy part.

## Part 3.4: Deprecation Metadata and Lifecycle Headers

### Decisions

- Trail should support deprecation metadata on both group or folder metadata and route metadata.
- The metadata key should be `deprecation`.
- If a full version folder is deprecated, child routes should inherit that deprecation automatically.
- Custom non-folder versioning strategies remain possible, but those teams must mark deprecation on specific routes manually.

### Inheritance

- Group or folder deprecation metadata should inherit to child routes.
- Route metadata may append or specialize deprecation details.
- Route metadata should not cancel inherited deprecation by default.

### OpenAPI Output

- Trail should emit OpenAPI `deprecated: true` where applicable.
- Trail should also emit vendor extension metadata for richer deprecation and lifecycle details.

### Runtime Headers

- Trail should support framework-managed lifecycle headers:
  - `Deprecation`
  - `Sunset`
  - `Link`
- Framework-managed lifecycle headers should be derived from `deprecation` metadata when lifecycle header config is enabled.
- If lifecycle header config is disabled, deprecation should remain documentation-only by default.
- Manual response headers should still be allowed.
- Framework-managed and manual headers should be merged.
- Trail should warn on conflicts between framework-managed and manual lifecycle headers.

### Replacement Guidance

- Trail should support replacement guidance for:
  - route
  - version
  - migration or documentation URL
- Default replacement guidance should use flexible string-based metadata.
- Trail may support optional typed route-reference validation for teams that want stronger checks.
- Typed replacement validation should be opt-in rather than required for all applications.

### Checks and Breaking Analysis

- `trail openapi check` should validate:
  - deprecation metadata shape
  - deprecation config format
  - dates and basic config correctness
- `trail openapi breaking` should handle lifecycle and migration expectations such as:
  - warning when a removed route was never deprecated first
  - warning when replacement guidance is missing if team policy requires it
  - warning when sunset metadata is missing if team policy requires it
