# Routa

Routa is a schema-first, OpenAPI-aware REST framework for new TypeScript APIs.

The framework is built around one idea: the HTTP contract should be explicit in source. Route files define inputs, responses, middleware, metadata, and handler boundaries. From that contract, Routa can generate typed handlers, runtime validation, and OpenAPI. Routa can also start from an OpenAPI file and scaffold the first version of the source contract.

Routa v0 is intentionally narrow:

- Hono runtime
- Zod schemas
- OpenAPI `.yaml` and `.json` input
- OpenAPI-to-source scaffolding
- Source-to-OpenAPI checking
- Typed route responses
- Minimal typed middleware context

The official project creation command will be:

```sh
pnpm create routa@latest
```

## Framework Model

Routa routes are filesystem-backed. Folders map to URL segments, and each `route.ts` file owns the methods for that path.

```txt
routes/users/route.ts
routes/users/$id/route.ts
```

Each method is declared as a route contract:

```ts
export default defineRoute({
	post: createRoute({
		input: {
			body: CreateUserSchema,
		},
		responses: {
			success: {
				status: 201,
				schema: UserSchema,
			},
		},
		run: async ({ input, ctx }) => {
			return users.createUser(input.body, ctx);
		},
	}),
});
```

Handlers return named outcomes from the declared response map. Business logic stays in application-owned services, modules, use cases, or domain code. Routa owns the HTTP boundary: routing, validation, middleware context, typed responses, and OpenAPI.

## Repo Layout

```txt
docs/                 Planning, design, and acceptance specs
docs/specs/v0/        v0 behavior contracts
docs/specs/v1/        deferred target behavior
```

Implementation files will live at the repo root as the v0 framework is built.

## Start Here

- [Framework overview](./docs/README.md)
- [v0 requirements](./docs/v0_requirements.md)
- [Acceptance specs](./docs/specs/README.md)
- [Backend framework design](./docs/backend_framework_design.md)
- [Middleware design](./docs/middleware_design.md)
- [Testing strategy](./docs/testing_strategy.md)

## Development Status

Routa is moving from design into v0 development. The acceptance specs in `docs/specs/v0/` are the current implementation target.

When implementation behavior conflicts with a spec, either update the spec intentionally or reject the implementation.
