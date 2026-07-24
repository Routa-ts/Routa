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

The official project creation command is:

```sh
pnpm create routa-ts@latest
```

## Framework Model

Routa routes are filesystem-backed. Folders map to URL segments, and each `route.ts` file owns the methods for that path.

```txt
src/routes/users/route.ts
src/routes/users/$id/route.ts
```

Each method is declared as a route contract:

```ts
export default createRouteRoot("/users")({
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
packages/core/        @routa-ts/core framework API
packages/cli/         @routa-ts/cli routa command
packages/create-routa-ts/ create-routa-ts package for pnpm create routa-ts
examples/basic-api/   End-to-end Routa example app
examples/full-api/    Middleware, groups, and tenant-scoped example app
scripts/              Build, packaging, and CI helper scripts
```

The repo uses pnpm workspaces and Turborepo for package task orchestration.

## Development

Developing Routa requires Node.js 24+ and pnpm 11.9.0. The repository includes
`.nvmrc` and pins pnpm in `package.json`.

```sh
pnpm install --frozen-lockfile
pnpm verify
```

`pnpm verify` matches the full local pre-PR workflow. During iteration, use `pnpm quality`
for formatting, typechecking, and unit tests; Turborepo caches repeated work.

## Start Here

- [Framework overview](./docs/README.md)
- [v0 requirements](./docs/v0_requirements.md)
- [Acceptance specs](./docs/specs/README.md)
- [Backend framework design](./docs/backend_framework_design.md)
- [Middleware design](./docs/middleware_design.md)
- [Testing strategy](./docs/testing_strategy.md)

## Community

- [Contributing](./CONTRIBUTING.md)
- [Governance](./GOVERNANCE.md)
- [Security](./SECURITY.md)
- [Code of Conduct](./CODE_OF_CONDUCT.md)
- [Trademark policy](./TRADEMARKS.md)
- [Issues](https://github.com/Routa-ts/Routa/issues)
- [Discussions](https://github.com/Routa-ts/Routa/discussions)

## Development Status

Routa has a v0 implementation baseline in this repo. The acceptance specs in `docs/specs/v0/` are the behavior contract for keeping v0 honest as the framework evolves.

When implementation behavior conflicts with a spec, either update the spec intentionally or reject the implementation.

## License

Routa is released under the [MIT License](./LICENSE).
