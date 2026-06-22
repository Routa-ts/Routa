# Trail

**A schema-first, OpenAPI-aware REST framework for new TypeScript APIs.**

Trail brings the developer experience of file-based frameworks to backend services: **schemas are the source of truth**, resource route files map cleanly to paths, contracts generate typed handlers and OpenAPI, and OpenAPI can scaffold the HTTP layer when a team starts from a spec.

Trail v0 is **Hono-based**, **Zod-only**, and focused on new APIs. Later versions may add other runtime adapters, but v0 optimizes for proving the core loop instead of pretending to be runtime-neutral too early.

## The Idea

Backend APIs should not require a maze of controllers, decorators, registries, adapters, and hand-written docs just to answer a simple question:

> What does this route accept, what can it return, and what context is available when it runs?

Trail is built around one source of truth:

```txt
schemas -> routes -> handlers -> OpenAPI -> docs/checks
```

When teams start from an API contract, Trail can also run the first step in reverse:

```txt
openapi.yaml/json -> schemas -> route files -> handler stubs
```

That OpenAPI-to-source path is a core feature, not an afterthought. It is meant for new APIs, AI-assisted planning, and teams that want to define the HTTP contract first and then focus on business logic.

```txt
routes/users/route.ts
routes/users/$id/route.ts
```

Each **route file** covers **one URL segment** (collection or item). Methods on that path (`get`, `post`, `patch`, …) are **`createRoute`** entries inside a single **`defineRoute`** export, so shared params, middleware, and metadata stay together. The framework handles the HTTP translation.

## Why Trail

### File-based APIs

Your backend shape should be visible from the filesystem. Trail uses **folders for URL segments** and **`route.ts` (or equivalent) files** for the contracts on that segment. Putting **all verbs for one path in one file** makes shared middleware, schemas, and OpenAPI metadata easier to keep consistent than scattering `get.ts`, `patch.ts`, and `delete.ts` across the tree.

### Contracts before handlers

Routes define their inputs and possible responses before business logic runs. That gives handlers, application code, clients, and documentation the same contract.

### OpenAPI to source

Trail v0 accepts OpenAPI `.yaml` and `.json` files and scaffolds the matching Zod schemas, resource route files, typed response variants, and HTTP handler stubs. Generated source is meant to be reviewed, edited, and kept under version control.

Trail does not ask developers to blindly trust generated contracts. OpenAPI input should be validated, linted, and reviewed before it becomes application source.

### Typed responses, not loose JSON

Route handlers return named outcomes like `success`, `notFound`, or `emailConflict`. If a route did not declare that response, TypeScript should reject it.

### Middleware that carries meaning

Auth, permissions, tenant loading, and request enrichment should not disappear into invisible side effects. Middleware declares what state it requires, what it guarantees, and which early responses it can produce.

### OpenAPI without a second model

The route contract is the documentation model. Inputs, outputs, middleware rejects, and global errors can all contribute to the generated API spec.

### HTTP layer only

Trail is opinionated where the HTTP layer needs consistency: routing, validation, context, middleware, responses, and docs. Trail does not generate or own your services, models, database, domain code, policies, or application architecture.

The handler lives at the route boundary. The service, use case, module, domain model, or any other business logic shape belongs to the developer.

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

The **method** (`post` here) is the map key under **`defineRoute`**. That `createRoute` says what the handler accepts, what it can return, and receives typed input and typed context. The handler may call any application-owned service, use case, module, or domain code. Trail turns the returned **`{ type, data }`** value into the HTTP response (including **`201`** for this `success` entry).

## The Mental Model

```txt
resource route files define a path segment and its HTTP methods
schemas define contracts
middleware defines context
business logic belongs to the application
Trail defines the HTTP boundary
```

That is the essence of the framework: make the API boundary explicit, typed, and easy to navigate without taking over the rest of the application.

## Built For

- Product teams starting new REST APIs in TypeScript
- Teams that want to scaffold source from OpenAPI contracts
- Teams that want OpenAPI without maintaining parallel documentation
- Backend codebases that have outgrown ad hoc controllers
- Services where auth, permissions, tenancy, and typed context matter
- Developers who want framework ergonomics without a heavy application architecture

## Current Status

Trail is currently in the design stage. This repository is the first articulation of the framework: the product direction, the core architecture, and the middleware model.

The next milestone is a v0 proof of concept that proves the core loop:

```txt
openapi.yaml/json -> Zod schemas -> Hono-backed route files -> HTTP handler stub -> OpenAPI check
```

v0 scope:

- Hono runtime adapter only
- Zod schemas only
- OpenAPI `.yaml` and `.json` input only
- OpenAPI-to-source scaffold
- Generated OpenAPI from route contracts
- Minimal typed middleware surface

Deferred beyond v0:

- Fastify, Express, or other runtime adapters
- Non-Zod schema adapters
- Broad security integrations
- Broad operational feature set

## Design Notes

The deeper architecture notes live here:

- [v0 requirements](./v0_requirements.md)
- [Acceptance specs](./specs/README.md)
- [Backend framework design](./backend_framework_design.md)
- [Middleware system design](./middleware_design.md)

## Naming Notes

Trail is the working name.

Reserved fallback names:

- **Routa**: close to routing, short, and framework-friendly.
- **Weave**: good if the framework leans into composing routes, middleware, contracts, docs, and checks.

possible domains:

- trailjs.dev
