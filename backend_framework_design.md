# Trail Backend Framework Design (WIP)

## Vision

Trail is a backend REST API framework inspired by frontend DX (Next.js, TanStack, Astro) with:

- Resource-oriented file routing (one route file per path segment, multiple HTTP methods per file)
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

Trail maps folders to URL segments. A **route file** exports **`defineRoute`**, which attaches **one path** (or one parameterized path) to **several HTTP verbs**, each described by a **`createRoute`** call. Shared params, middleware, tags, and schemas for that path live in **one place**, which scales better than splitting every verb into `get.ts`, `patch.ts`, and so on.

### File structure

```
routes/
  users/
    route.ts          # parent: GET /users (list), POST /users (create, 201), …
  users/$id/
    route.ts          # child: GET|PATCH|DELETE /users/:id — always use params + methods here
```

**Parent vs dynamic child:** Collection verbs (**including `post` create with success `201`**) live on the **parent** segment file (`users/route.ts`). A **dynamic** folder (`users/$id/`) only holds handlers that need that param; it **does not** replace the parent file—both segments are required so the tree matches the REST surface.

### `defineRoute` shape

**Collection segment** (verbs on the folder’s path only):

```ts
export default defineRoute({
	get: createRoute({
		/* list users */
	}),
	post: createRoute({
		/* create user */
	}),
});
```

**Item segment** (path params shared by every method in the file):

```ts
export default defineRoute({
	params: ParamsSchema,
	methods: {
		get: createRoute({
			/* fetch one */
		}),
		patch: createRoute({
			/* partial update */
		}),
		delete: createRoute({
			/* remove */
		}),
	},
});
```

The HTTP verb for each handler comes from the key (`get`, `post`, `methods.patch`, …). Individual `createRoute` values do not repeat a `method` field.

**Dynamic segments (`…/$id/`):** Always use **`params` + `methods`** on that file so every method on the item shares the same path param typing. Do not use a lone `get: createRoute({ input: { params } })` at the root of `defineRoute` for `$id` routes—lift **`params`** to `defineRoute` and nest verbs under **`methods`** (see `http_contract_group1_wrapup.md` consolidated example).

### Rules

- `$id` → dynamic param
- `$` → catch-all
- `(group)` → grouping without affecting URL

---

## Route Definition

```ts
export default defineRoute({
	post: createRoute({
		middleware: [requireAuth()],

		input: {
			body: CreateUserSchema,
			query: QuerySchema,
			params: ParamsSchema,
		},

		responses: {
			success: {
				status: 201,
				schema: UserSchema,
			},
			emailConflict: {
				status: 409,
				schema: EmailConflictSchema,
			},
		},

		run: async ({ input, ctx }) => {
			return userService.createUser({
				body: input.body,
				actorId: ctx.state.auth.principal.id,
			});
		},
	}),
});
```

---

## Responses & Service Contract

- Responses are defined in the route
- Framework generates a **union type** over **`{ type, data }`** (see `http_contract_group1_wrapup.md`)
- Services (or **`run`**) return that shape: **`data`** is the payload only; errors omit HTTP **`status`** in **`data`** (status comes from the `responses` entry)

Example:

```ts
type CreateUserResponse =
	| { type: "success"; data: User }
	| {
			type: "emailConflict";
			data: { title: string; code: string; email: string };
	  };
```

### Service example

```ts
return {
	type: "emailConflict",
	data: {
		title: "Email already exists",
		code: "EMAIL_CONFLICT",
		email: "taken@example.com",
	},
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
    auth
    tenant
    custom middleware data

  raw:
    hono (escape hatch)
```

### Example

```ts
run: async ({ input, ctx }) => {
	const user = await userService.createUser({
		body: input.body,
		actorId:
			ctx.state.auth.status === "authenticated"
				? ctx.state.auth.principal.id
				: undefined,
	});
	return { type: "success", data: user };
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

- Resource-oriented route files with per-method contracts
- Schema-driven contracts
- No controllers
- No heavy DI
- Clean service layer

---

## Next Step: Middleware System

### To Define

- Middleware file structure (`middleware.ts`)
- Execution order (global → group → resource route file → method)
- How middleware extends `ctx.state`
- Type-safe state injection
- Auth patterns
- Error propagation
