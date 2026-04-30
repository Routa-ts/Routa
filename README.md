# RouteStack

RouteStack is a work-in-progress backend REST API framework design focused on bringing frontend-style developer experience to backend services.

The core idea is simple: define API routes from files, describe their inputs and responses with schemas, keep business logic in plain services, and let the framework handle HTTP concerns such as validation, response mapping, middleware flow, and OpenAPI generation.

## Goals

- File-based routing for REST APIs
- Schema-first request and response contracts
- Strongly typed route handlers and service return values
- OpenAPI generation from route and middleware definitions
- Minimal framework-owned context with a safe escape hatch
- Middleware that can type-safely extend request state
- A non-opinionated service layer with no controller or heavy DI requirement

## Design Principles

1. Schemas define the contract.
2. Routes consume schemas.
3. Services return typed results.
4. The framework translates those results into HTTP responses.

RouteStack is intended to be opinionated about the HTTP boundary while staying flexible about application internals such as services, tools, models, persistence, and domain logic.

## File-Based Routing

Routes are mapped from the filesystem:

```txt
routes/
  users/
    get.ts
    post.ts
    $id/
      get.ts
      patch.ts
```

Routing conventions:

- `$id` creates a dynamic parameter.
- `$` creates a catch-all route.
- `(group)` creates a grouping folder without changing the URL.

This keeps route discovery predictable and removes the need for a separate controller registry.

## Route Definition

A route declares its input schemas, possible responses, optional middleware, and handler:

```ts
export default createRoute({
  input: {
    body: CreateUserSchema,
    query: QuerySchema,
    params: ParamsSchema,
  },

  responses: {
    success: {
      status: 200,
      schema: UserSchema,
    },
    emailConflict: {
      status: 409,
      schema: EmailConflictSchema,
    },
  },

  run: async ({ input, ctx }) => {
    return userService.create(input.body)
  },
})
```

The framework uses the response keys to generate a typed result union. Services must return one of the responses declared by the route.

```ts
return {
  type: "emailConflict",
  message: "Email already exists",
}
```

Returning an undeclared response should fail at the type level.

## Error Handling

RouteStack separates business errors from unexpected failures.

Declared errors are part of the route contract and can be returned by services or middleware. Unhandled errors are caught globally and mapped to global error responses.

```ts
defineGlobalErrors({
  internalError: {
    status: 500,
    schema: InternalErrorSchema,
  },
})
```

Global errors can be overridden at global, group, or route level.

## Validation

Inputs are always validated in development and production. Output validation is enabled in development and can be made optional in production.

| Validation | Dev | Prod |
| ---------- | --- | ---- |
| Input      | Yes | Yes  |
| Output     | Yes | Optional |

## Context

RouteStack exposes its own framework context rather than coupling route code directly to an underlying HTTP library.

```txt
ctx:
  core:
    requestId
    method
    path
    url
    env
    logger

  request:
    ip
    userAgent
    headers
    cookies

  state:
    user
    tenant
    custom middleware data

  raw:
    hono
```

`ctx.raw` exists as an escape hatch, but normal application code should use the portable RouteStack context.

## Middleware

Middleware is designed to be typed, composable, and integrated with route responses and OpenAPI output.

Middleware can define:

- `requires`: state that must already exist
- `provides`: state that may be added
- `guarantees`: state that will exist if the middleware continues
- `rejects`: early responses the middleware may return

```ts
export default defineMiddleware({
  requires: {
    user: UserSchema,
  },

  guarantees: {
    permissions: PermissionsSchema,
  },

  rejects: {
    cannotLoadPermissions: {
      status: 500,
      schema: CannotLoadPermissionsSchema,
    },
  },

  run: async ({ ctx, next }) => {
    const permissions = await getPermissions(ctx.state.user.id)

    if (!permissions) {
      return {
        type: "cannotLoadPermissions",
        message: "Failed to load permissions",
      }
    }

    return next({
      state: {
        permissions,
      },
    })
  },
})
```

Middleware can only extend `ctx.state`. It cannot modify `ctx.core` or `ctx.request`.

Execution order:

```txt
global -> group -> folder -> route -> handler
```

Final route responses include:

```txt
route.responses
+ middleware.rejects
+ global errors
```

## Architecture Boundary

RouteStack owns the HTTP-facing workflow:

```txt
routes -> schemas -> handler -> HTTP
```

Application code remains flexible:

```txt
services -> tools -> models
```

This keeps the framework focused on contracts, routing, validation, context, and response handling while avoiding unnecessary constraints on business logic.

## Repository Contents

- [backend_framework_design.md](./backend_framework_design.md): core framework design, routing, route contracts, context, validation, and error handling.
- [middleware_design.md](./middleware_design.md): typed middleware design, execution order, state guarantees, rejects, and OpenAPI integration.

## Status

RouteStack is currently a design-stage project. The repository contains architectural notes and examples rather than a packaged implementation.

## Next Steps

- Finalize route and schema APIs.
- Define the middleware file structure.
- Prototype route discovery and type generation.
- Implement response union branding.
- Generate OpenAPI from route and middleware contracts.
- Add examples for authentication, permissions, and resource CRUD routes.
