# Routa Backend Framework Design (WIP)

## Vision

Routa is a backend REST API framework inspired by frontend DX (Next.js, TanStack, Astro) with:

- Schemas as the framework source of truth
- OpenAPI-to-source scaffolding for the HTTP layer of new APIs
- Resource-oriented file routing (one route file per path segment, multiple HTTP methods per file)
- Strong typing via schemas (Zod in v0)
- OpenAPI generation
- Hono as the v0 runtime adapter
- Minimal, portable context
- Application-owned service/domain layer

---

## Core Principles

1. **Schemas are the source of truth**
2. **Routes consume schemas**
3. **OpenAPI is generated from schemas and route contracts**
4. **OpenAPI can scaffold schemas and route source**
5. **Routa handles the HTTP boundary through Hono in v0**
6. **Application services and domain logic stay user-owned**

---

## v0 Runtime Position

Routa v0 is Hono-based.

- Routa route contracts compile to Hono route handling.
- Routa owns the public route, schema, middleware, and response APIs.
- Hono is the only runtime adapter in v0.
- Runtime portability is a future adapter goal, not a v0 promise.

Future adapters such as Fastify or Express may be added after the core contract model is proven. The adapter boundary should be kept internal enough that v0 users do not write Hono-specific code unless they intentionally use the raw escape hatch.

---

## Source of Truth

Routa's source of truth is the schema-backed contract model.

```txt
Zod schemas
+ route contracts
+ middleware contracts
= route graph
= typed handlers
= OpenAPI
= checks and docs
```

Route handler types come from the route graph:

```txt
schemas -> handler input type
responses -> allowed return variants
middleware flow -> handler ctx type
```

Middleware is resolved in order from global to group folders, resource segment folders, route-file middleware, and method middleware before ctx inference. Routa records resolved route metadata in `.routa/routes.gen.ts`.

For spec-first starts, Routa can create the initial source from OpenAPI:

```txt
openapi.yaml/json -> Zod schemas -> route files -> HTTP handler stubs
```

After scaffolding, HTTP-layer source remains normal editable TypeScript. Routa should protect user-written route logic during regeneration through previews, diffs, and conflict detection. Routa does not generate or own business services.

---

## Public API Import Convention

Routa's public API should prefer direct, specific imports over one large namespace object.

- Developers import the helper, middleware, function, or condition they need.
- Documentation should teach direct imports.
- Namespaced access may exist internally or optionally, but should not be the primary style.
- This convention applies across framework helpers, middleware, functions, conditions, and route utilities.

Examples:

```ts
import { defineRoute, createRoute } from "@routa/core";
import { Fields, Sort } from "@routa/core/query/helpers";
import { requireAuth } from "@routa/core/middleware/auth";
```

---

## Routing

Routa maps folders to URL segments. A **route file** exports **`defineRoute`**, which attaches **one path** (or one parameterized path) to **several HTTP verbs**, each described by a **`createRoute`** call. Shared params, middleware, tags, and schemas for that path live in **one place**, which scales better than splitting every verb into `get.ts`, `patch.ts`, and so on.

### File structure

```
routes/
  users/
    route.ts          # parent: GET /users (list), POST /users (create, 201), …
  users/$id/
    route.ts          # child: GET|PATCH|DELETE /users/:id — always use params + methods here
```

**Parent vs dynamic child:** Collection verbs (**including `post` create with success `201`**) live on the **parent** segment file (`users/route.ts`). A **dynamic** folder (`users/$id/`) only holds handlers that need that param; it **does not** replace the parent file—both segments are required so the tree matches the REST surface.

### Route authoring styles

Routa v0 generated output uses directory-style route files:

```txt
routes/users/route.ts
routes/users/$id/route.ts
```

Flat dot routes are deferred to v1:

```txt
routes/users.ts
routes/users.$id.ts
```

Future flat route support should resolve into the same route graph as directory routes. Mixed directory and flat routes should be allowed in one project without a style config, but conflicting route ownership must fail build/check. For example, `routes/users/route.ts` and `routes/users.ts` both resolve to `/users`, so Routa must report a duplicate route conflict instead of choosing one silently.

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

## Responses & Route Contract

- Responses are defined in the route
- Framework generates a **union type** over **`{ type, data }`** (see `http_contract_group1_wrapup.md`)
- **`run`** returns that shape: **`data`** is the payload only; errors omit HTTP **`status`** in **`data`** (status comes from the `responses` entry)
- Application services may return this shape if the developer chooses, but Routa does not require or generate services.

Example:

```ts
type CreateUserResponse =
	| { type: "success"; data: User }
	| {
			type: "emailConflict";
			data: { title: string; code: string; email: string };
	  };
```

### Handler return example

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
- Route handlers cannot return undeclared responses

---

## Error Handling

### Two categories:

1. **Declared errors (business logic)**
   - Defined in `responses`
   - Returned by `run` after application code chooses that outcome

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

Routa uses its own context (not Hono directly).

### Structure

```
ctx:
  core:
    requestId
    routeId
    routePattern
    method
    path
    url
    env (explicitly exposed request-safe env only)
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
Routa Opinionated:
schemas → routes → handler contract → OpenAPI → Hono HTTP boundary

User Flexible:
services → use cases → modules → policies → tools → models
```

---

## Differentiator

- Schema source of truth for routes, OpenAPI, handlers, and checks
- OpenAPI-to-source scaffold for new APIs
- Resource-oriented route files with per-method contracts
- No controllers
- No required heavy DI; optional typed services
- Hono-backed v0 with future adapter path
- Service, domain, and application architecture owned by the developer

---

## Next Step: Middleware System

### To Define

- Middleware file structure (`middleware.ts`)
- Execution order (global → group → resource segment → resource route file → method)
- How middleware extends `ctx.state`
- Type-safe state injection
- Auth patterns
- Error propagation
