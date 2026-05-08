# Trail

**A schema-first REST framework for teams that want backend APIs to feel as clear, typed, and navigable as modern frontend apps.**

Trail brings the developer experience of file-based frameworks to backend services: **resource route files** map cleanly to paths, **each file can hold every HTTP method** for that path behind **`defineRoute`**, contracts are defined up front, middleware is part of the type system, and OpenAPI falls out of the same source of truth your code already uses.

It is for teams that like the ergonomics of Next.js, Astro, and TanStack, but want that same clarity at the API boundary.

## The Idea

Backend APIs should not require a maze of controllers, decorators, registries, adapters, and hand-written docs just to answer a simple question:

> What does this route accept, what can it return, and what context is available when it runs?

Trail is built around making that answer obvious.

```txt
routes/users/route.ts
routes/users/$id/route.ts
```

Each **route file** covers **one URL segment** (collection or item). Methods on that path (`get`, `post`, `patch`, …) are **`createRoute`** entries inside a single **`defineRoute`** export, so shared params, middleware, and metadata stay together. The framework handles the HTTP translation.

## Why Trail

### File-based APIs

Your backend shape should be visible from the filesystem. Trail uses **folders for URL segments** and **`route.ts` (or equivalent) files** for the contracts on that segment. Putting **all verbs for one path in one file** makes shared middleware, schemas, and OpenAPI metadata easier to keep consistent than scattering `get.ts`, `patch.ts`, and `delete.ts` across the tree.

### Contracts before handlers

Routes define their inputs and possible responses before business logic runs. That gives handlers, services, clients, and documentation the same contract.

### Typed responses, not loose JSON

Services return named outcomes like `success`, `notFound`, or `emailConflict`. If a route did not declare that response, TypeScript should reject it.

### Middleware that carries meaning

Auth, permissions, tenant loading, and request enrichment should not disappear into invisible side effects. Middleware declares what state it requires, what it guarantees, and which early responses it can produce.

### OpenAPI without a second model

The route contract is the documentation model. Inputs, outputs, middleware rejects, and global errors can all contribute to the generated API spec.

### Framework at the boundary, freedom inside

Trail is opinionated where APIs need consistency: routing, validation, context, middleware, responses, and docs. Your services, models, database, and domain code remain yours.

## What It Feels Like

```ts
export default defineRoute({
	post: createRoute({
		middleware: [requireAuth()],

		input: {
			body: CreateUserSchema,
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
			return users.createUser({
				body: input.body,
				actorId: ctx.state.auth.principal.id,
			});
		},
	}),
});
```

The **method** (`post` here) is the map key under **`defineRoute`**. That `createRoute` says what the handler accepts, what it can return, and receives typed input and typed context. **`users.createUser`** returns the framework-generated **`{ type, data }`** union for this route (same contract as `http_contract_group1_wrapup.md`). Trail turns that value into the HTTP response (including **`201`** for this `success` entry).

## The Mental Model

```txt
resource route files define a path segment and its HTTP methods
schemas define contracts
middleware defines context
services define behavior
Trail defines the HTTP boundary
```

That is the essence of the framework: make the API boundary explicit, typed, and easy to navigate without taking over the rest of the application.

## Built For

- Product teams building REST APIs in TypeScript
- Teams that want OpenAPI without maintaining parallel documentation
- Backend codebases that have outgrown ad hoc controllers
- Services where auth, permissions, tenancy, and typed context matter
- Developers who want framework ergonomics without a heavy application architecture

## Current Status

Trail is currently in the design stage. This repository is the first articulation of the framework: the product direction, the core architecture, and the middleware model.

The next milestone is a small prototype that proves the core loop:

```txt
route file -> schema contract -> typed handler -> typed response -> OpenAPI
```

## Design Notes

The deeper architecture notes live here:

- [Backend framework design](./backend_framework_design.md)
- [Middleware system design](./middleware_design.md)

## Naming Notes

Trail is the working name.

Reserved fallback names:

- **Routa**: close to routing, short, and framework-friendly.
- **Weave**: good if the framework leans into composing routes, middleware, contracts, and services.

possible domains:

- trailjs.dev
