# basic-api

Routa API generated with `pnpm create routa@latest`.

## Development

```sh
pnpm install
pnpm dev
```

`pnpm dev` runs `routa dev`, which validates the route graph, generates Routa metadata, typechecks, and starts the internal development server.

## Scripts

```sh
pnpm dev
pnpm start
pnpm check
pnpm build
pnpm lint
pnpm format
pnpm openapi:check
```

## Routes

`src/routa.ts` is the user-owned Routa entry point. Routes live in `src/routes`.

```txt
src/routa.ts
src/routes/status/route.ts
src/routes/status/schemas.ts
```

Routa owns generated project metadata in `.routa/`. Commit those files so OpenAPI drift and regeneration safety work across machines.
