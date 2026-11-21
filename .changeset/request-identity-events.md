---
"@routa-ts/core": minor
"@routa-ts/cli": minor
"create-routa-ts": patch
---

Generate a request identity for every request, add opt-in correlation, and replace the automatic request events with safe ones.

- Every request that reaches a Routa app gets a UUID that Routa generates and never takes from the request. Middleware, services factories, and handlers read it as readonly `ctx.requestId`, every response carries it as `x-request-id`, and it holds for unmatched requests, validation failures, middleware rejects, authentication failures, `406`, automatic `OPTIONS`, `405`, and server errors. It stays with `logger: false`.
- New `correlation` option in `createRouta` and `createHonoApp`: `true` reads `x-correlation-id`, `{ header: "x-trace-ref" }` another header, compared case-insensitively. Routa accepts one value of 1 to 128 ASCII letters, digits, `.`, `_`, or `-`, exposes it as `ctx.correlationId`, binds it to the request logger, and echoes it in the same response header. An absent, empty, repeated, or otherwise invalid value is ignored without rejecting the request. A header that is not a valid name, or that names `x-request-id`, `authorization`, `proxy-authorization`, `cookie`, `set-cookie`, or another header Routa owns, is rejected at startup and by `routa check`. New types `RequestIdentityContext` and `CorrelationConfig`.
- `ctx.logger` is now a request logger: a child of the configured logger bound to `requestId`, and `correlationId` when accepted, which event data and later `child()` bindings cannot replace. The configured logger, and every module that imports it, stays without request identity. Services factories receive the same request logger.
- `http.request` is replaced by `http.response.prepared`, written once per prepared response with `requestId`, `correlationId` when present, `method` (a standard method or `_OTHER`), `route` (the route pattern or `[Unmatched]`), `status`, and `durationMs`. It says the response was prepared, not sent. `http.error` now carries `requestId`, `method`, `route`, `status`, and handler-output `issues`, and no longer the request path or any error's message, name, stack, or authentication scheme.
- `requestId`, `correlationId`, and `logger` are reserved context keys like `services`: TypeScript, `routa check` (`ROUTA_CONTEXT_RESERVED`), and registration reject middleware that provides one or passes one to `next()`, and an assignment that bypasses the types fails the request. `x-request-id` and the configured correlation header are reserved response headers: TypeScript (for `x-request-id`), `routa check` (`ROUTA_RESPONSE_HEADER_RESERVED`), and registration reject an outcome or reject that declares one, and Routa sets both last on every response.
- `routa check` reads `correlation` from `src/routa.ts` without running it and reports `ROUTA_CORRELATION_CONFIG_UNRESOLVED`, `ROUTA_CORRELATION_HEADER_INVALID`, `ROUTA_CORRELATION_HEADER_CONFLICT`, and the warning `ROUTA_CORRELATION_SPREAD_UNRESOLVED`. `.routa/routes.gen.ts` exports `routaCorrelationHeader` when correlation is on, and startup refuses a `src/routa.ts` that disagrees with it.
- Generated OpenAPI documents `x-request-id` on every operation response, and the correlation header as optional when correlation is on. `routa scaffold` and `create-routa-ts` write `x-request-id` into the baselines they create.

Migration:

- Remove middleware that provided `requestId`, `correlationId`, or `logger`, and read `ctx.requestId` instead. To keep a caller-supplied ID, turn on `correlation` and read `ctx.correlationId`; it never replaces the request identity.
- Remove `x-request-id`, and the correlation header if you turn correlation on, from outcome and reject `headers`.
- Update log queries and alerts from `http.request` to `http.response.prepared`, and from `path` to `route`. `http.error` no longer carries error text; an error reporter that receives the original error is not shipped yet.
- Run `routa generate`, then `routa openapi breaking --update-baseline` once to accept the new response headers into `.routa/openapi-baseline.json`. `routa openapi breaking` reports no breaking change for them.
- A client that reads every response header should expect `x-request-id`.
