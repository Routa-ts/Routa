# v0 Spec: Middleware and Routes Metadata

## Feature

Routa resolves global, group, resource segment, route-file, and method middleware into route-specific pipelines and generates route metadata for typechecking.

The ctx type belongs to the resolved route. Routa should not use one giant global `AppCtx` that gives every route fields only provided by protected or admin middleware.

## Scope

In v0:

- Global, group, and resource segment middleware files are named `middleware.ts`.
- Group folders use `(group)` syntax and do not add URL segments.
- Middleware is inherited in this order: global, group, resource segment, route file, method contract.
- Route-file middleware runs before per-method `createRoute(...)` middleware.
- Middleware declares `requires`, `provides`, `rejects`, and the HTTP `input` it reads.
- Routa validates middleware order through the route graph.
- Routa generates `.routa/routes.gen.ts` with resolved route metadata.

## Acceptance Cases

```yaml
case: v0_middleware_requires_previous_provider
intent: middleware cannot run before required ctx exists
input:
  middleware:
    - requireAuth:
        requires: db
    - withDb:
        provides: db
action: routa check
expected:
  behavior:
    - Routa reports invalid middleware order
    - diagnostic names missing ctx.db
    - diagnostic suggests moving withDb before requireAuth
failure:
  mode: check failure or type error
```

```yaml
case: v0_group_and_segment_middleware_inherit_in_order
intent: group folders do not affect URL paths but do affect middleware order
input:
  files:
    routes/middleware.ts: withDb
    routes/(private)/middleware.ts: requireAuth
    routes/(private)/(admin)/middleware.ts: requireAdmin
    routes/(private)/(admin)/users/middleware.ts: loadUsersResource
    routes/(private)/(admin)/users/route.ts: route-file middleware
    routes/(private)/(admin)/users/route.ts post: method middleware
action: compile route graph
expected:
  behavior:
    - resolved path is /users
    - resolved middleware order is global, private group, admin group, users segment, route file, method
    - handler ctx includes db, user, admin, users resource state, route-file state, and method state
must_not:
  - add /private or /admin to the URL path
  - apply method middleware before route-file middleware
```

```yaml
case: v0_generated_routes_file_records_resolved_middleware
intent: .routa/routes.gen.ts captures route-specific middleware pipeline
input:
  route: routes/(admin)/users/route.ts
action: routa check
expected:
  files:
    - .routa/routes.gen.ts
  behavior:
    - generated route metadata includes resolved path
    - generated route metadata includes methods
    - generated route metadata includes URL-less group folders
    - generated route metadata includes resource segment folders
    - generated route metadata includes ordered middleware list
    - generated route-specific ctx type is available for typechecking
```

```yaml
case: v0_route_file_middleware_runs_before_method_middleware
intent: defineRoute middleware applies to all methods before createRoute middleware
input:
  route:
    file: routes/users/$id/route.ts
    defineRoute:
      middleware:
        - loadUserResource
      methods:
        get:
          middleware: []
        patch:
          middleware:
            - requirePermission
action: compile route graph
expected:
  behavior:
    - GET /users/:id includes loadUserResource
    - PATCH /users/:id includes loadUserResource then requirePermission
    - handler ctx for patch includes route-file ctx before method ctx
must_not:
  - apply patch middleware to get
  - run method middleware before route-file middleware
```

```yaml
case: v0_route_ctx_is_route_specific
intent: admin middleware ctx does not leak into unrelated routes
input:
  files:
    routes/(admin)/middleware.ts:
      provides: admin
    routes/(admin)/users/route.ts: uses ctx.state.admin
    routes/public/status/route.ts: does not inherit admin middleware
action: typecheck routes
expected:
  behavior:
    - admin users route can access ctx.state.admin
    - public status route cannot access ctx.state.admin
must_not:
  - expose admin ctx through a global AppCtx for every route
```

## Required Diagnostics

Middleware order diagnostics should include:

- route file
- middleware file or symbol
- missing ctx field
- earlier middleware chain when available
- short ordering suggestion when possible

## Out of Scope

- Full auth provider system.
- Broad middleware plugin ecosystem.
- Flat route generation.
- One global application ctx type for all routes.
