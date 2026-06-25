# OpenAPI and API Evolution Design (Group 3)

## Scope

This document records decisions for Group 3 in small parts.

## Part 3.1: OpenAPI Source Model and Contract Metadata

### Decisions

- Routa is schema-source-first.
- Routa supports both source-to-OpenAPI generation and OpenAPI-to-source scaffolding.
- Routa's normal application source of truth is the schema-backed route contract system:
  - route contracts
  - schemas
  - middleware contracts
  - guard metadata
  - global errors
- Routa v0 accepts OpenAPI `.yaml` and `.json` input for scaffolding.
- Routa v0 generates Zod schemas only.
- Routa supports spec-first workflows for AI-assisted and contract-driven teams:
  - `scaffold`
  - `check`
  - `diff`
- `defineRoute` is the main route authoring surface for OpenAPI-relevant contract data.
- Schema-level OpenAPI metadata from Zod `.openapi(...)` is first-class.
- Users should not need to declare the same contract information in multiple places.

### OpenAPI-to-Source v0

Routa v0 can scaffold source from OpenAPI:

```txt
openapi.yaml/json
-> Zod schemas
-> resource route files
-> typed response variants
-> handler stubs
```

The scaffolded source is reviewed, committed, and edited like normal application code. Routa should not silently overwrite user-authored business logic.

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
- Security metadata that cannot map cleanly to Routa middleware placeholders.

### Route Metadata

- Tags are optional.
- If tags are omitted, Routa defaults to the top-level folder name.
- Routes may explicitly override tags when needed.
- Examples should come primarily from schema `.openapi(...)` metadata.
- Route-level example metadata may be added when schema metadata is not sufficient.

### Security Scheme Model

- Routa supports a global OpenAPI security scheme registry.
- Per-route security requirements should be derived primarily from guards and route configuration.
- Routa should support simple security declarations for common schemes and richer declarations where needed, especially for OAuth-style scopes.

### Auth and Authz Boundary

- OpenAPI `security` documents the authentication mechanism, such as:
  - bearer token
  - session/cookie
  - API key
  - OAuth2
- Routa should not prescribe one authorization structure for every application.
- Applications define their own authorization vocabulary and policy model, including roles, permissions, scopes, or custom policy concepts.
- Routa documents required capabilities at the route boundary, but does not attempt to encode full internal authorization logic as framework-owned semantics.

### Guard-Driven OpenAPI

- Guards are the base truth for auth and authz documentation.
- `requireAuth()` contributes authentication requirements and related `401` responses.
- `requirePermission(...)` contributes required capability metadata and related `403` responses.
- `authorizeResource(...)` should also emit the required capability or action by default.
- Route-level metadata may append explanation text, but should not override guard-derived auth or authz requirements.
- OpenAPI should document required authentication and required action/capability, but should not attempt to serialize internal resource policy logic.

### Middleware Contract and OpenAPI Contribution

- Middleware remains part of Routa's normal contract system.
- Middleware contract fields should include:
  - `requires`
  - `provides`
  - `guarantees`
  - `input`
  - `rejects`
  - `run`
- Routa should derive OpenAPI from the normal middleware contract rather than from duplicated OpenAPI-only declarations.
- Custom middleware should be able to contribute public contract metadata automatically through the same Routa-standard structures used elsewhere.

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
- Core contract concerns such as input, rejects, and security should not be redefined inside `openapi`; Routa should infer those from the main middleware contract and guard configuration.

### OpenAPI Extensions for Authz

- Routa may emit vendor extension metadata for required capabilities.
- This metadata should stay generic rather than forcing one authorization model.
- A generic extension such as `x-routa-authz` is preferred over a permission-only name.
- This extension may expose required actions or capabilities for documentation and tooling, while leaving application policy structure fully developer-owned.

## Part 3.2: OpenAPI Outputs, Docs, Checks, and SDK Boundary

### Decisions

- Routa emits `openapi.json` by default.
- The OpenAPI output path should be configurable.
- Routa should support built-in documentation UI.
- The default documentation renderer is `Scalar`.
- `Swagger UI` is supported as an optional renderer.
- Switching renderers should be configuration-based rather than architectural.
- Documentation should be enabled by default in development.
- Documentation should require explicit enablement in production.

### Docs Exposure and Guardrails

- Production exposure guardrails should cover both:
  - documentation UI
  - raw `openapi.json`
- If production OpenAPI exposure is enabled, Routa should require explicit exposure intent or warn by default.
- Exposure intent should allow decisions such as:
  - audience: `public` or `internal`
  - protected: `true` or `false`
- Routa should not force one specific authentication or protection implementation for docs exposure.
- `--strict` should escalate production OpenAPI exposure warnings to failures.

### Renderer Configuration

- Shared documentation configuration should live in a common docs config block.
- Renderer-specific configuration should live under nested renderer keys such as:
  - `docs.scalar`
  - `docs.swagger`
- Routa should use renderer library defaults when the user does not configure renderer-specific options.
- Routa should use upstream public configuration types when those types are available and stable.
- If upstream renderer config typing is missing or unstable, Routa should support a documented subset of known-good options.

### Contract Checks

- `routa check` should be the top-level project validation command.
- `routa openapi check` should be a built-in CLI command.
- Both commands should be easy to run in CI.
- Both commands should return a non-zero exit code on failure.
- `routa check` should include Routa contract/schema/route checks and TypeScript typechecking without emitting JavaScript.
- `routa build` should reuse Routa graph validation before TypeScript emit and fail without emitting when graph validation fails.
- `routa build` should not require a redundant `tsc --noEmit` pass before TypeScript emit.
- Default check severity should favor warnings for quality issues.
- `--strict` should escalate configured warnings to failures.

### Check Scope

- `routa openapi check` should focus on:
  - drift between generated and provided or committed spec
  - contract quality
- `routa check` may include relevant OpenAPI checks, but it is broader than OpenAPI drift and quality.

For v0, checks should focus on:

- generated OpenAPI matches route contracts
- scaffold input quality for `.yaml` and `.json`
- unsupported v0 features
- stable route/schema/operation naming

### Contract Quality Checks

- Routa should warn about missing tags.
- Routa should warn about missing examples.
- Routa should warn about missing security metadata where expected.
- Routa should warn about duplicate or conflicting `operationId` values.
- Routa should warn about invalid or inconsistent contract metadata that degrades documentation or tooling quality.

### `operationId`

- Routa should auto-generate `operationId` by default.
- Route metadata may override the generated `operationId`.
- Routa should warn about duplicate or conflicting generated or overridden `operationId` values.
- Teams may enforce stricter `operationId` policy through `routa openapi check --strict`.

### SDK Generation Boundary

- Routa should not own full SDK generation in v1.
- Routa should produce clean OpenAPI output that works well with external SDK generators.
- Routa should document recommended SDK generation workflows.
- Routa v1 should aim to be SDK-ready rather than ship a built-in SDK generator.

### Scope Boundary

- Routa owns:
  - OpenAPI spec generation
  - documentation serving
  - contract checks
- Routa does not own full SDK generation in v1.

## Part 3.3: Versioning Strategy and Breaking-Change Analysis

### Decisions

- Routa recommends path-based API versioning.
- First-class versioning support in v1 is path-based only.
- Versioning should be route and folder based rather than group-alias based.
- Versioned APIs should be organized through route folders such as:
  - `routes/v1/tasks/route.ts`
  - `routes/v2/tasks/route.ts`
- Multiple live API versions should be supported through versioned route folders.

### Other Versioning Styles

- Header-based versioning and media-type versioning remain possible.
- Routa's existing header validation, content negotiation, and route contract features are sufficient for manual implementations of those styles.
- Routa does not define a first-class abstraction for non-path versioning styles in v1.
- Documentation should recommend path-based versioning while making it clear that teams may implement other strategies manually.

### `routa openapi check`

- `routa openapi check` should focus on:
  - drift
  - contract quality
  - docs and spec quality rules
- `routa openapi check` should not own breaking-change analysis.

### Breaking-Change Command

- Breaking-change analysis should use a separate command:
  - `routa openapi breaking`
- The breaking-change command should compare compatibility and report breaking changes only.
- The breaking-change command should compare the current generated OpenAPI output against a stored baseline snapshot file.
- Routa should use a fixed default baseline path.
- Routa should also allow an explicit alternate baseline path through a CLI flag.
- If no baseline file exists, `routa openapi breaking` should instruct the developer to create one.
- The command should support baseline creation and replacement through:
  - `routa openapi breaking --update-baseline`
- After reporting changes, the command should tell the developer how to accept the current contract as the new baseline.
- Default breaking-change severity should be `info`.
- Teams should be able to raise breaking-change severity as an API stabilizes.
- The command should support:
  - `--severity=info|warn|error`

### Breaking-Change Scope

- Routa should report removed paths.
- Routa should report removed methods.
- Routa should report added required input.
- Routa should report optional input changed to required.
- Routa should report incompatible request schema narrowing.
- Routa should report removed response variants, statuses, or media types.
- Routa should report incompatible response schema changes.
- Routa should report tighter authentication requirements.
- Routa should report route moves or renames that break clients.

### Evolution Posture

- Routa should recommend additive API evolution by default.
- Routa should express this posture through baseline comparison tooling rather than through runtime enforcement.
- Routa should not block intentional breaking changes, but it should make them explicit.
- This compatibility posture should work whether or not the application uses explicit API versioning.
- If explicit API versioning is used, introducing a new version should be the recommended path for incompatible changes.

### Lifecycle Posture

- Routa should support lifecycle metadata and version status fields for teams that want them.
- Routa should not enforce overlap windows or retirement policy.
- Detailed deprecation behavior belongs in the deprecation part of this group rather than in the versioning strategy part.

## Part 3.4: Deprecation Metadata and Lifecycle Headers

### Decisions

- Routa should support deprecation metadata on both group or folder metadata and route metadata.
- The metadata key should be `deprecation`.
- If a full version folder is deprecated, child routes should inherit that deprecation automatically.
- Custom non-folder versioning strategies remain possible, but those teams must mark deprecation on specific routes manually.

### Inheritance

- Group or folder deprecation metadata should inherit to child routes.
- Route metadata may append or specialize deprecation details.
- Route metadata should not cancel inherited deprecation by default.

### OpenAPI Output

- Routa should emit OpenAPI `deprecated: true` where applicable.
- Routa should also emit vendor extension metadata for richer deprecation and lifecycle details.

### Runtime Headers

- Routa should support framework-managed lifecycle headers:
  - `Deprecation`
  - `Sunset`
  - `Link`
- Framework-managed lifecycle headers should be derived from `deprecation` metadata when lifecycle header config is enabled.
- If lifecycle header config is disabled, deprecation should remain documentation-only by default.
- Manual response headers should still be allowed.
- Framework-managed and manual headers should be merged.
- Routa should warn on conflicts between framework-managed and manual lifecycle headers.

### Replacement Guidance

- Routa should support replacement guidance for:
  - route
  - version
  - migration or documentation URL
- Default replacement guidance should use flexible string-based metadata.
- Routa may support optional typed route-reference validation for teams that want stronger checks.
- Typed replacement validation should be opt-in rather than required for all applications.

### Checks and Breaking Analysis

- `routa openapi check` should validate:
  - deprecation metadata shape
  - deprecation config format
  - dates and basic config correctness
- `routa openapi breaking` should handle lifecycle and migration expectations such as:
  - warning when a removed route was never deprecated first
  - warning when replacement guidance is missing if team policy requires it
  - warning when sunset metadata is missing if team policy requires it
