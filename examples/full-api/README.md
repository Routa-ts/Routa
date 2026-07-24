# Routa full API showcase

A runnable showcase of Routa's public application features. It combines a hand-owned runtime API with an isolated, reproducible OpenAPI scaffold fixture.

Run commands from the repository root unless a command starts with `cd examples/full-api`.

## Start the API

```sh
pnpm install
cd examples/full-api
export ROUTA_DEMO_SESSION_SECRET=dev-secret
pnpm dev
```

`pnpm dev` validates the route graph, regenerates `.routa/routes.gen.ts`, typechecks, and starts the server. The default config binds `127.0.0.1:3000`.

Runtime configuration is executable and typed in `src/routa.ts`:

- `host` and `port` provide application defaults.
- `HOST=0.0.0.0 PORT=4000 pnpm dev` demonstrates runtime environment overrides.
- The example adapts Pino to Routa's backend-agnostic logger interface. Pino is an example dependency, not part of Routa's contract. Development uses `pino-pretty` for readable terminal output; `NODE_ENV=production pnpm start` keeps structured JSON for log collectors.
- `LOG_LEVEL=debug pnpm dev` configures Pino's minimum level.
- `ROUTA_DEMO_LOGGER=off pnpm dev` demonstrates `logger: false`; routes still receive a typed no-op `ctx.logger` and do not need conditional logging code.
- `ROUTA_DEMO_LOGGER_SHOWCASE=on` explicitly enables the dedicated logger exercise route; it returns `403` by default so normal runs cannot emit demonstration `error` or `fatal` events.
- `lifecycleHeaders: true` emits deprecation, sunset, and replacement headers.

## Feature map

| Public feature                                                          | Concrete example                                                                                     |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Typed route contracts and validated results                             | Every file in `src/routes`; `GET /showcase/:itemId` has route-owned `success` and `notFound` results |
| GET, POST, PUT, PATCH, DELETE, HEAD                                    | Application-owned contracts; `src/routes/showcase/$itemId/route.ts` adds PUT and explicit HEAD       |
| Automatic OPTIONS and derived `Allow`                                 | `OPTIONS /showcase/:itemId` advertises GET, HEAD, OPTIONS, and PUT                                   |
| 200, 201, 204, 400, 401, 403, 404, 405, 406, 415                        | Runnable requests below                                                                              |
| Params, query, headers, cookies, JSON body                              | Project, session, audit, and showcase routes                                                         |
| Zod parsing and coercion                                                | `verbose` uses `z.stringbool()`; scaffold query parameters generate boolean/number coercion          |
| Global, group, segment, route, and method middleware                    | `src/routes/middleware.ts`, `(private)`, `admin`, tenant, and project contracts                      |
| Middleware `requires`, `provides`, typed rejects, security, permissions | `src/middleware` and private route graph                                                             |
| `Fields()` and `Sort()` query helpers                                   | `GET /tenants/:tenantId/projects`                                                                    |
| Directory, flat, dynamic-flat, group, and dynamic-segment routing       | `status/route.ts`, `legacy.ts`, `legacy.$id.ts`, `(private)`, `$tenantId`                            |
| Local and absolute-URL deprecation replacements                         | `/legacy` points to `/status`; `/legacy/:id` points to a reserved `.invalid` external URL            |
| Host, port, env overrides, disabled/custom logger                       | `src/routa.ts`, `src/logger.ts`, and start commands above                                             |
| Complete typed logger in route context                                  | `POST /logger-showcase` and `pnpm logger:exercise` exercise every `RoutaLogger` capability             |
| OpenAPI drift and breaking-change baseline                              | `.routa/openapi-baseline.json` and scripts below                                                     |
| Safe scaffold preview/update with manifest ownership                    | `scaffold/openapi.yaml` and `scaffold/.routa/manifest.json`                                          |
| Scaffolded formats, nullable values, maps, unions, const                | `scaffold/src/routes/catalog/items/$itemId/schemas.ts`                                               |
| CLI validation, generation, build, route reference                      | `check`, `generate`, `build`, `routes`, and `routes:json` scripts                                    |

## Route layout

```txt
src/routes/
  middleware.ts
  status/route.ts
  auth/session/route.ts
  demo/route.ts
  logger-showcase/route.ts             # opt-in RoutaLogger capability exercise
  showcase/$itemId/route.ts              # GET, PUT, HEAD; OPTIONS is automatic
  legacy.ts                               # flat route; local replacement
  legacy.$id.ts                           # dynamic flat route; external replacement
  (private)/
    middleware.ts
    admin/
      middleware.ts
      audit-events/route.ts
      reports.ts                          # nested flat route
    tenants/$tenantId/
      middleware.ts
      projects/route.ts                   # GET, POST
      projects/$projectId/route.ts        # GET, PATCH, DELETE
```

## Exercise the runtime

Mint signed session cookies:

```sh
cd examples/full-api
export ROUTA_DEMO_SESSION_SECRET=dev-secret
SESSION=$(node scripts/mint-session.mjs admin)
WRITER=$(node scripts/mint-session.mjs acme:writer)
```

Public routes, route-owned results, and content negotiation:

```sh
curl -s http://127.0.0.1:3000/status
curl -s -H 'Accept: application/problem+json' http://127.0.0.1:3000/demo
curl -s 'http://127.0.0.1:3000/showcase/item-1?verbose=true'       # 200 success
curl -s -i http://127.0.0.1:3000/showcase/missing                  # 404 notFound
```

Both showcase requests emit a route-owned `showcase.item_read` info event through the configured `ctx.logger`, followed by Routa's global `http.request` event. The same configured logger instance is used for both paths. `RoutaLogger` supports `trace`, `debug`, `info`, `warn`, `error`, `fatal`, and a `silent` no-op, plus child bindings and level checks; the adapter maps that portable surface to Pino.

### Exercise every logger capability

The dedicated `POST /logger-showcase` route keeps deliberate log-level demonstrations away from normal application endpoints. It is disabled by default. Start it locally with the lowest level enabled:

```sh
cd examples/full-api
export ROUTA_DEMO_SESSION_SECRET=dev-secret
ROUTA_DEMO_LOGGER_SHOWCASE=on LOG_LEVEL=trace pnpm dev
```

In another terminal, run the local-only exercise script:

```sh
cd examples/full-api
pnpm logger:exercise
```

The script sends one request for each capability:

| Capability | Concrete behavior |
| --- | --- |
| `log` | Sends a complete structured Routa event at `info`. |
| `trace`, `debug`, `info`, `warn`, `error`, `fatal` | Calls the matching typed method with event name, message, and structured data. |
| `silent` | Calls the typed no-op; no route-owned event is emitted, though the normal `http.request` lifecycle event still appears. |
| `child` | Derives a logger carrying `showcase` and middleware-provided `requestId` bindings. |
| `bindings` | Reads the child bindings and returns only confirmation booleans, never backend-owned process or host fields. |
| `isLevelEnabled` | Checks the requested level; the response shows both that result and whether the operation log was emitted. |

This command intentionally produces `warn`, `error`, and `fatal` severity examples. Use it only for the local showcase; the explicit environment gate prevents accidental normal or production traffic from doing so.

To exercise the same complete call path through Routa's disabled logger, restart with the no-op configuration and rerun the script:

```sh
ROUTA_DEMO_LOGGER=off ROUTA_DEMO_LOGGER_SHOWCASE=on pnpm dev
pnpm logger:exercise
```

Every request still succeeds, `operationLogEmitted` and all level checks are `false`, and no route or lifecycle logs are written. This demonstrates that handlers need no conditional logger guards.

Normal PUT and HEAD contracts, plus framework-owned OPTIONS:

```sh
curl -s -X PUT -H 'Content-Type: application/json' \
  -d '{"name":"Replacement","active":true}' \
  http://127.0.0.1:3000/showcase/item-1
curl -s -I http://127.0.0.1:3000/showcase/item-1
curl -s -i -X OPTIONS http://127.0.0.1:3000/showcase/item-1
```

The automatic response is bodyless `204` with `Allow: GET, HEAD, OPTIONS, PUT`. Applications never declare an `options` contract, so the header cannot drift from the route.

A CORS preflight receives the same derived method list without Routa silently granting an origin; origin and request-header permission remain an explicit CORS policy decision:

```sh
curl -s -i -X OPTIONS \
  -H 'Origin: https://app.example.invalid' \
  -H 'Access-Control-Request-Method: PUT' \
  -H 'Access-Control-Request-Headers: content-type' \
  http://127.0.0.1:3000/showcase/item-1
```

Framework-generated client errors:

```sh
curl -s -i 'http://127.0.0.1:3000/showcase/item-1?verbose=maybe'    # 400 validation
curl -s -i -X PUT -H 'Content-Type: application/json' -d '{' \
  http://127.0.0.1:3000/showcase/item-1                            # 400 invalid JSON
curl -s -i -X PUT -H 'Content-Type: text/plain' -d 'name=test' \
  http://127.0.0.1:3000/showcase/item-1                            # 415
curl -s -i -H 'Accept: text/html' http://127.0.0.1:3000/showcase/item-1 # 406
curl -s -i -X POST http://127.0.0.1:3000/showcase/item-1           # 405 + Allow
```

Middleware scopes, permissions, helpers, and bodyless DELETE:

```sh
curl -s -i http://127.0.0.1:3000/tenants/acme/projects             # typed 401
curl -s -H "Cookie: session=$WRITER" \
  'http://127.0.0.1:3000/tenants/acme/projects?fields=id,%20name&sort=-name'
curl -s -i -X POST -H "Cookie: session=$SESSION" \
  -H 'Content-Type: application/json' -d '{"name":"Nope"}' \
  http://127.0.0.1:3000/tenants/acme/projects                     # typed 403
curl -s -X POST -H "Cookie: session=$WRITER" \
  -H 'Content-Type: application/json' -d '{"name":"Launch"}' \
  http://127.0.0.1:3000/tenants/acme/projects                     # 201
curl -s -i -X DELETE -H "Cookie: session=$WRITER" \
  http://127.0.0.1:3000/tenants/acme/projects/project_1           # bodyless 204
curl -s -H "Cookie: session=$SESSION" \
  'http://127.0.0.1:3000/admin/audit-events?limit=2'
curl -s -H "Cookie: session=$SESSION" http://127.0.0.1:3000/admin/reports
```

Deprecation lifecycle headers:

```sh
curl -s -i http://127.0.0.1:3000/legacy
curl -s -i http://127.0.0.1:3000/legacy/old-project
```

The second response advertises `https://api.example.invalid/...` only as metadata. `.invalid` is reserved; the example never requires an external request.

## Safe scaffolding workflow

The runtime API is application-owned because its generated starting point was moved into middleware groups and gained business logic. It therefore has no scaffold manifest claiming ownership.

`scaffold/` is a separate TypeScript Routa project used only to demonstrate regeneration. Its manifest paths exactly match its generated route, schema, metadata, and baseline files.

```sh
cd examples/full-api
pnpm scaffold:preview    # read-only; every entry should be "= unchanged"
pnpm scaffold:update     # explicit --yes regeneration after reviewing the preview
```

`scaffold/openapi.yaml` demonstrates:

- path-level parameters and GET/PUT/HEAD generation (OPTIONS remains runtime-owned);
- UUID, email, URL, and date-time formats;
- nullable OpenAPI 3.1 type arrays;
- `additionalProperties` maps;
- `anyOf` unions and string `const` discriminants;
- boolean and number wire-value coercion for query parameters.

Routa deliberately rejects `oneOf`, `allOf`, OpenAPI 3.0 `nullable`, and other unsupported schema forms with scaffold diagnostics; this healthy fixture uses only supported public forms.

Scaffold input also rejects explicit `OPTIONS` operations. The runtime derives OPTIONS from the generated application methods.

## Validation and OpenAPI workflow

```sh
cd examples/full-api
pnpm check
pnpm generate
pnpm build
pnpm lint
pnpm scaffold:preview
pnpm openapi:check
pnpm openapi:breaking
pnpm logger:exercise       # while the opt-in local showcase server is running
pnpm routes
pnpm routes:json
```

After an intentional runtime contract change, review it and update the committed baseline explicitly:

```sh
pnpm openapi:update
pnpm openapi:check
pnpm openapi:breaking
```

The baseline keeps component names and metadata stable while Routa regenerates paths, inputs, middleware security/permissions, deprecations, and response contracts from source.

## Deliberate scope

This example covers public APIs that belong in a healthy application. It does not force invalid-project diagnostic branches, low-level Hono adapter plumbing, compile-time-only utility types, or the interactive project-creation wizard into runtime routes. Those surfaces are exercised by CLI/core tests and the dedicated creation flow; representing them as successful API endpoints would be misleading.
