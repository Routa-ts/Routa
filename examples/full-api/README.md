# examples/full-api

Routa monorepo example that exercises the framework fixes from the recent review: runtime middleware contracts, typed rejects, query helpers, bodyless DELETE, group middleware, and OpenAPI drift tooling.

Uses workspace-linked `@routa-ts/cli` and `@routa-ts/core` — run from the repository root.

## Development

```sh
pnpm install # from the repository root
cd examples/full-api
export ROUTA_DEMO_SESSION_SECRET=dev-secret
pnpm dev
```

`pnpm dev` runs `routa dev`, which validates the route graph, regenerates `.routa/routes.gen.ts`, typechecks, and starts the server on port 3000.

## What this example shows

| Feature                                                                     | Where                                                           |
| --------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Global middleware (`withRequest` → `withSession`)                           | `src/routes/middleware.ts`                                      |
| Group middleware `(private)` + app-owned `requireAuth`                      | `src/routes/(private)/middleware.ts`                            |
| Segment middleware (`withAdmin`, `withTenant`)                              | `admin/middleware.ts`, `tenants/$tenantId/middleware.ts`        |
| Route + method middleware                                                   | `projects/route.ts` (`withProjectScope`, `withProjectListMode`) |
| Typed `rejects` (401/403) instead of raw `Response` throws                  | `withProjectPermissions`, `withAdmin`, `requireAuth`            |
| Runtime `requires` / `provides` validation                                  | Missing `session` → 401 from `requireAuth`, not a 500           |
| `Fields()` / `Sort()` query helpers (whitespace-trimmed fields)             | list projects query                                             |
| Bodyless `DELETE` → **204**                                                 | `DELETE /tenants/:tenantId/projects/:projectId`                 |
| Headers + cookies inputs                                                    | `x-request-id`, `session` cookie                                |
| Hand-written `defineRoute` + Accept `*+json`                                | `GET /demo`                                                     |
| OpenAPI scaffold + baseline drift check                                     | `openapi.yaml`, `pnpm openapi:check`                            |

## Route layout

```txt
src/routes/
  middleware.ts                          # withRequest, withSession
  status/route.ts                        # GET /status
  auth/session/route.ts                  # GET /auth/session
  demo/route.ts                          # GET /demo (hand-written)
  (private)/
    middleware.ts                        # requireAuth (typed 401)
    admin/
      middleware.ts                      # withAdmin
      audit-events/route.ts              # GET /admin/audit-events
    tenants/$tenantId/
      middleware.ts                      # withTenant
      projects/route.ts                  # GET, POST /tenants/:tenantId/projects
      projects/$projectId/route.ts       # GET, PATCH, DELETE .../:projectId
```

## Scripts

```sh
pnpm dev
pnpm start
pnpm check
pnpm build
pnpm lint
pnpm format
pnpm scaffold              # routa scaffold openapi.yaml
pnpm openapi:check
pnpm routes
pnpm routes:json
```

## Try it

Mint a signed session cookie (requires `ROUTA_DEMO_SESSION_SECRET`):

```sh
export ROUTA_DEMO_SESSION_SECRET=dev-secret
SESSION=$(node scripts/mint-session.mjs admin)
WRITER=$(node scripts/mint-session.mjs acme:writer)
```

```sh
# Public status
curl -s http://127.0.0.1:3000/status

# Accept application/*+json (no longer 406)
curl -s -H 'Accept: application/problem+json' http://127.0.0.1:3000/demo

# Unauthenticated private route → typed 401 from requireAuth
curl -s -i http://127.0.0.1:3000/tenants/acme/projects

# Authenticated list with Fields/Sort (fields may include spaces)
curl -s -H "Cookie: session=$WRITER" \
  'http://127.0.0.1:3000/tenants/acme/projects?fields=id,%20name&sort=-name'

# Write without permission → typed 403 from withProjectPermissions
curl -s -i -X POST -H "Cookie: session=$SESSION" -H 'Content-Type: application/json' \
  -d '{"name":"Nope"}' http://127.0.0.1:3000/tenants/acme/projects

# Writer creates a project
curl -s -X POST -H "Cookie: session=$WRITER" -H 'Content-Type: application/json' \
  -d '{"name":"Launch"}' http://127.0.0.1:3000/tenants/acme/projects

# Bodyless delete → 204
curl -s -i -X DELETE -H "Cookie: session=$WRITER" \
  http://127.0.0.1:3000/tenants/acme/projects/project_1

# Admin audit feed
curl -s -H "Cookie: session=$SESSION" \
  'http://127.0.0.1:3000/admin/audit-events?limit=2'
```

## OpenAPI

- `openapi.yaml` is the scaffold source for generated routes/schemas.
- `GET /demo` is hand-written on purpose (not scaffold-owned) and still appears in the live OpenAPI baseline after `routa check`.
- Commit `.routa/` so drift and regeneration safety work across machines.

```sh
pnpm openapi:check
```
