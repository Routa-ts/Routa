# v0 Spec: Route Contracts

## Feature

Routa route files define the HTTP boundary. They consume Zod schemas, define method contracts, run route handlers, and map typed handler outcomes into HTTP responses. Application business logic remains outside Routa.

v0 generated output uses directory-style route files. Flat dot route support is deferred to v1, but the route graph model should not prevent it.

Handler types are inferred from route declarations:

```txt
schemas -> handler input type
responses -> allowed return variants
resolved middleware -> handler ctx type
```

## Acceptance Cases

```yaml
case: v0_route_generation_directory_style_only
intent: v0 generated routes use the canonical directory layout
input:
  openapi:
    paths:
      /users/{id}:
        get:
          operationId: getUserById
action: routa scaffold openapi.yaml
expected:
  files:
    - routes/users/$id/route.ts
    - routes/users/$id/schemas.ts
  behavior:
    - generated route graph maps to /users/:id
must_not:
  - generate routes/users.$id.ts in v0
```

```yaml
case: v0_route_collection_methods_share_path
intent: multiple collection methods live in one route file
input:
  route: routes/users/route.ts
  methods:
    - get
    - post
action: compile route graph
expected:
  behavior:
    - GET /users maps to routes/users/route.ts get
    - POST /users maps to routes/users/route.ts post
    - route file can share imports and metadata
must_not:
  - require get.ts and post.ts files
```

```yaml
case: v0_route_item_methods_share_params
intent: item route methods share path params
input:
  route: routes/users/$id/route.ts
  params:
    id: string
  methods:
    - get
    - patch
action: compile route graph
expected:
  behavior:
    - GET /users/:id and PATCH /users/:id use the same params schema
    - handlers receive typed params
must_not:
  - duplicate params schema inside every method unless user opted into custom structure
```

```yaml
case: v0_route_handler_input_inferred_from_schemas
intent: handlers receive typed input without manual annotations
input:
  route:
    input:
      params: GetUserParams
      query: GetUserQuery
      body: UpdateUserBody
action: typecheck route
expected:
  behavior:
    - input.params is inferred from GetUserParams
    - input.query is inferred from GetUserQuery
    - input.body is inferred from UpdateUserBody
must_not:
  - require user-authored handler input annotations
```

```yaml
case: v0_route_response_variant_required
intent: handlers return declared variants only
input:
  route:
    responses:
      success: 200
      notFound: 404
  handler_return:
    type: emailConflict
action: typecheck route
expected:
  behavior:
    - TypeScript rejects undeclared response variant
    - response data is typed from the declared response schema
failure:
  mode: compile-time type error where possible
```

```yaml
case: v0_route_success_schema_required
intent: every non-delete route has a success response shape
input:
  method: get
  responses: {}
action: compile route graph
expected:
  behavior:
    - Routa graph validation reports missing success schema
    - routa build fails before emitting JavaScript
failure:
  mode: check failure or type error
```

## Required Route Behavior

- `GET` must not accept request body in v0.
- `HEAD` may be derived from `GET`.
- `OPTIONS` is auto-handled from declared route methods and cannot be declared as a route contract.
- Unsupported method on an existing path returns `405`.
- Unsupported request content type returns `415`.
- Unsupported response `Accept` returns `406`.

## Out of Scope

- Custom content-type parser registry.
- Full serializer plugin system.
- Non-Hono runtime compilation.
- Generated flat route output.
