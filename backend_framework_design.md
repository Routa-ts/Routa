# Trail Backend Framework Design (WIP)

## Vision

Trail is a backend REST API framework inspired by frontend DX (Next.js, TanStack, Astro) with:

- File-based routing
- Strong typing via schemas (Zod/SOD)
- OpenAPI generation
- Minimal, portable context
- Non-opinionated service layer

---

## Core Principles

1. **Schemas first**
2. **Routes consume schemas**
3. **Services return typed results**
4. **Trail handles HTTP**

---

## Routing

### File Structure

```
routes/
  users/
    get.ts
    post.ts
    $id/
      get.ts
      patch.ts
```

### Rules

- `$id` → dynamic param
- `$` → catch-all
- `(group)` → grouping without affecting URL

---

## Route Definition

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
		return userService.create(input.body);
	},
});
```

---

## Responses & Service Contract

- Responses are defined in the route
- Framework generates a **union type**
- Service must return one of those types

Example:

```ts
type Response =
  | { type: "success"; ... }
  | { type: "emailConflict"; ... }
```

### Service Example

```ts
return {
	type: "emailConflict",
	message: "Email already exists",
};
```

---

## Type System

- `type` field is auto-generated from response key
- Framework applies internal branding
- Services cannot return undeclared responses

---

## Error Handling

### Two categories:

1. **Declared errors (business logic)**
   - Defined in `responses`
   - Returned by services

2. **Unhandled errors**
   - Handled globally
   - Default 500 response

### Global Errors

```ts
defineGlobalErrors({
	internalError: {
		status: 500,
		schema: InternalErrorSchema,
	},
});
```

### Overrides

- Global
- Group-level (`errors.ts`)
- Route-level

---

## Validation Strategy

| Type   | Dev | Prod        |
| ------ | --- | ----------- |
| Input  | ✅  | ✅          |
| Output | ✅  | ⚙️ optional |

---

## Context Design

Trail uses its own context (not Hono directly).

### Structure

```
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
    hono (escape hatch)
```

### Example

```ts
run: async ({ input, ctx }) => {
	return userService.create({
		data: input.body,
		userId: ctx.state.user?.id,
	});
};
```

---

## Architecture Boundaries

```
Trail Opinionated:
routes → schemas → handler → HTTP

User Flexible:
services → tools → models
```

---

## Differentiator

- File-based routing for backend APIs
- Schema-driven contracts
- No controllers
- No heavy DI
- Clean service layer

---

## Next Step: Middleware System

### To Define

- Middleware file structure (`middleware.ts`)
- Execution order (global → group → route)
- How middleware extends `ctx.state`
- Type-safe state injection
- Auth patterns
- Error propagation
