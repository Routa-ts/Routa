# Trail Middleware System Design

## Overview

Trail's middleware system is responsible for:

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
global → group → segment folder → route file → method contract → handler
```

---

## Middleware Contract

Each middleware can define:

```
requires:
  State that must exist before execution

provides:
  State that may be added (optional)

guarantees:
  State that will exist if middleware continues

input:
  Contract inputs the middleware depends on

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

	openapi: {
		description: "Loads permission context for the authenticated actor.",
		extensions: {
			"x-trail-context": ["permissions"],
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

Final `ctx.state` is the combination of all middleware:

```
global
+ group
+ segment folder
+ route file
+ method contract
= final state
```

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

No optional chaining if guaranteed.

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
- If route responses, middleware rejects, or global errors share the same HTTP status, Trail must merge them into one OpenAPI response entry for that status.
- If same-status variants have different payload shapes, Trail should document that status with `oneOf`.
- If same-status variants expose different media types, Trail should merge them under the same status entry and media-type map.
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
requires must be fulfilled by previous guarantees
```

- TypeScript should fail if:

```
middleware requires state not guaranteed before
```

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
