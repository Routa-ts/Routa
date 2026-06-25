# Routa Middleware System Design

## Overview

Routa's middleware system is responsible for:

- Enriching the request context (`ctx.state`)
- Enforcing guards (auth, permissions, etc.)
- Declaring possible early responses (rejects)
- Contributing to OpenAPI documentation

Middleware is **fully typed**, composable, and integrated into the route contract system.

---

## Middleware Levels

Middleware can exist at multiple levels:

1. Global
2. Group (folder with `(group)` syntax)
3. Resource segment (URL folder, e.g. `users/` or `users/$id/`)
4. Resource route file (shared middleware and metadata for every method on that segment)
5. Per-method contract (`createRoute` for a single verb)
6. Handler (`run`)

Execution order:

```
global → group → resource segment → route file → method contract → handler
```

Global, group, and resource segment middleware files are named `middleware.ts`.

Groups use folder syntax such as `(public)`, `(private)`, or `(admin)`. A group participates in middleware inheritance but does not add a URL segment. This lets a project collect routes under shared behavior without changing paths.

The root `routes/middleware.ts` file is global middleware for the route tree.

Example:

```txt
routes/
  middleware.ts
  (private)/
    middleware.ts
    users/
      route.ts
  (admin)/
    middleware.ts
    reports/
      route.ts
```

In this layout:

- `routes/(private)/users/route.ts` resolves to `/users`.
- `routes/(admin)/reports/route.ts` resolves to `/reports`.
- `(private)/middleware.ts` can require auth for private routes.
- `(admin)/middleware.ts` can require admin ctx without putting `/admin` in the URL.

Example pipeline for `routes/(admin)/users/route.ts`:

```txt
routes/middleware.ts
-> routes/(admin)/middleware.ts
-> routes/(admin)/users/middleware.ts
-> routes/(admin)/users/route.ts middleware
-> createRoute(...) middleware
-> handler
```

Middleware inheritance is resolved before route handler ctx inference.

---

## Middleware Contract

Each middleware can define:

```
requires:
  ctx fields that must already exist

provides:
  ctx fields added for later middleware and handlers

input:
  HTTP input the middleware reads

rejects:
  Possible early responses

openapi:
  Extra docs-only metadata not already expressed elsewhere
```

---

## Example Middleware

```ts
export default defineMiddleware({
	input: {
		headers: {
			"x-workspace-id": z.string(),
		},
	},

	requires: {
		auth: AuthenticatedAuthSchema,
	},

	provides: {
		debugInfo: DebugSchema.optional(),
		permissions: PermissionsSchema,
	},

	rejects: {
		cannotLoadPermissions: {
			status: 500,
			schema: CannotLoadPermissionsSchema,
		},
	},

	openapi: {
		description: "Loads permission context for the authenticated actor.",
		extensions: {
			"x-routa-context": ["permissions"],
		},
	},

	run: async ({ ctx, next }) => {
		const permissions = await getPermissions(ctx.state.auth.principal.id);

		if (!permissions) {
			return {
				type: "cannotLoadPermissions",
				data: {
					title: "Failed to load permissions",
					code: "PERMISSIONS_LOAD_FAILED",
				},
			};
		}

		return next({
			state: {
				permissions,
				debugInfo: maybeDebug,
			},
		});
	},
});
```

---

## Context Rules

Middleware can only extend:

```
ctx.state
```

They cannot modify:

```
ctx.core
ctx.request
```

---

## State Typing

Final `ctx.state` is the combination of all middleware in the resolved route pipeline:

```
global middleware
+ group middleware
+ resource segment middleware
+ route file middleware
+ method contract middleware
= final state
```

The ctx type belongs to the resolved route, not the whole app. Routa should avoid a global `AppCtx` that lets every route access fields only provided by protected or admin middleware.

### Example

```
runtime → ctx.core.requestId
auth → auth
permissions → permissions
route file → shared resource flags
method contract → verb-specific flags
```

Handler receives:

```ts
ctx.state.auth.principal.id;
ctx.state.permissions;
```

No optional chaining if provided by the resolved route pipeline.

---

## Rejects

Middleware can return early responses using declared types. Rejects use the same **`{ type, data }`** envelope as route handlers (**`data`** matches the reject schema; no HTTP **`status`** inside **`data`** when it is implied by the reject declaration).

```ts
return {
	type: "invalidToken",
	data: {
		title: "Invalid token",
		code: "INVALID_TOKEN",
	},
};
```

Mapping:

```
type → status → schema → OpenAPI
```

---

## OpenAPI Integration

Final route responses include:

```
each method’s createRoute.responses (within defineRoute)
+ middleware.rejects (all levels)
+ global errors
```

OpenAPI generation rules:

- OpenAPI may only document one response entry per HTTP status code.
- If route responses, middleware rejects, or global errors share the same HTTP status, Routa must merge them into one OpenAPI response entry for that status.
- If same-status variants have different payload shapes, Routa should document that status with `oneOf`.
- If same-status variants expose different media types, Routa should merge them under the same status entry and media-type map.
- Runtime typing remains variant-based by `type`, even when documentation merges them under one status code.
- Middleware `input` contributes request contract documentation the same way route input does.
- Middleware `openapi` is docs-only metadata for information not already declared through `input`, `rejects`, or guard configuration.
- Middleware `openapi` should stay minimal and is limited to:
  - `description`
  - `extensions`

---

## Middleware Types

### 1. Data Loaders

Add data to context:

```
auth → auth
permissions → permissions
```

### 2. Guards

Validate and block:

```
requirePermission
requireTenant
```

---

## Composition Rules

- Middleware must satisfy dependencies:

```
requires must be fulfilled by previous provides
```

- TypeScript should fail if:

```
middleware requires state not provided before
```

Routa check should also report framework-aware ordering diagnostics, such as:

```txt
requireAuth requires ctx.db,
but ctx.db is not provided by earlier middleware.

Suggestion:
Move withDb before requireAuth.
```

## Generated Route Metadata

Routa generates resolved route metadata in:

```txt
.routa/routes.gen.ts
```

Conceptual flow:

```txt
filesystem scan
-> route tree
-> inherited middleware chain
-> .routa/routes.gen.ts
-> route-specific ctx types
-> routa check validates route handlers
```

The generated file should include route file, resolved path, methods, group folders, resource segment folders, route-file middleware, method middleware, and route-specific ctx types.

Example metadata should preserve the distinction between a URL-less group and a URL segment:

```ts
export const routeTree = {
	routes: [
		{
			file: "routes/(admin)/users/route.ts",
			path: "/users",
			groups: ["(admin)"],
			segments: ["users"],
			methods: ["GET", "POST"],
			middleware: [
				"routes/middleware.ts",
				"routes/(admin)/middleware.ts",
				"routes/(admin)/users/middleware.ts",
				"routes/(admin)/users/route.ts",
			],
		},
	],
} as const;
```

---

## Route-file Middleware

A **`defineRoute`** export can attach middleware shared by every method in that route file. This is useful for resource loading or route-level guards that apply to all verbs on the same path.

```ts
export default defineRoute({
	middleware: [loadUserResource()],

	params: UserParams,

	methods: {
		get: createRoute({
			run: async ({ ctx }) => {
				ctx.state.userResource;
			},
		}),
		patch: createRoute({
			middleware: [requirePermission("users.update")],
			run: async ({ ctx }) => {
				ctx.state.userResource;
			},
		}),
	},
});
```

In this example, `loadUserResource()` runs for both `get` and `patch`. The `patch` method then adds method-specific middleware after the route-file middleware.

---

## Method-level middleware

A specific **`createRoute`** (one HTTP method on a path) can attach middleware; siblings on the same **`defineRoute`** export are unaffected unless they share file-level middleware.

```ts
export default defineRoute({
	post: createRoute({
		middleware: [requirePermission("users.create")],
		// …`input`, `responses`, etc.

		run: async ({ ctx }) => {
			ctx.state.auth.principal.id;
		},
	}),
});
```

---

## Execution Behavior

Middleware can only:

```
1. return next({ state })
2. return { type: ... } (reject)
3. throw → handled as global error
```

---

## Design Goals

- Strong type safety
- No runtime guessing
- Composable and predictable
- OpenAPI aligned
- Framework-controlled flow
