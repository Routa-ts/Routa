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
3. Resource folder
4. Route/method level

Execution order:

```
global → group → folder → route → handler
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

rejects:
  Possible early responses
```

---

## Example Middleware

```ts
export default defineMiddleware({
	requires: {
		user: UserSchema,
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

	run: async ({ ctx, next }) => {
		const permissions = await getPermissions(ctx.state.user.id);

		if (!permissions) {
			return {
				type: "cannotLoadPermissions",
				message: "Failed to load permissions",
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
+ folder
+ route
= final state
```

### Example

```
global → requestId
auth → user
permissions → permissions
route → specific flags
```

Handler receives:

```ts
ctx.state.user.id;
ctx.state.permissions;
```

No optional chaining if guaranteed.

---

## Rejects

Middleware can return early responses using declared types:

```ts
return {
	type: "invalidToken",
	message: "Invalid token",
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
route.responses
+ middleware.rejects (all levels)
+ global errors
```

---

## Middleware Types

### 1. Data Loaders

Add data to context:

```
auth → user
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

## Method-Level Middleware

Routes can define specific middleware:

```ts
export default createRoute({
	middleware: [requirePermission("users.create")],

	run: async ({ ctx }) => {
		ctx.state.user.id;
	},
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
