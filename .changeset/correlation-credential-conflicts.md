---
"@routa-ts/core": minor
"@routa-ts/cli": minor
---

Reject a correlation header that a configured credential scheme reads.

- `correlation` can no longer name the header an `apiKey()` scheme's `header` or a `custom()` scheme's `transport.header` declares, in any casing. `routa check` reports `ROUTA_CORRELATION_HEADER_CONFLICT` with the scheme's kind and name, such as `The correlation header "X-API-Key" in src/routa.ts names x-api-key, which the apiKey scheme "serviceKey" reads its credential from.`. It compares the scheme declarations it reads from source and never runs an authenticator or extractor; a scheme header it cannot read is reported as `ROUTA_AUTH_CONFIG_UNRESOLVED`, as before. Startup, `createApplication`, and `createHonoApp` throw a `TypeError` naming the scheme before they serve a request. `createApplication` compares the header with the schemes where it already read them, after the services factory, and releases the services the factory constructed when they conflict. `bearer()` and the cookie schemes read `authorization` and `cookie`, which were already rejected.
- `routa scaffold` reads the same scheme declarations and stops with `ROUTA_CORRELATION_HEADER_CONFLICT` before it writes any file.
- Routa does not support mounting one Routa app in another with Hono's `route()`. A mounted Routa app answers every request that reaches it, whether a Routa route, a Hono handler added to it, or nothing would answer it, with Routa's internal `500` problem, and runs no authenticator. The response keeps the outer app's `x-request-id`, and neither app echoes nor logs a correlation ID. The mounted app logs `http.error` and reports to its `onRequestError` with the new code `configuration_error` and the new stage `identity`. The error says the app is mounted in another Routa app, which Routa does not support, and what to do instead, and holds no header value. A Routa app mounted in a plain Hono app, a plain Hono app mounted in a Routa app, and an app reached through `fetch` or Hono's `mount()` work as before.

Migration:

- If `correlation` names a header one of your credential schemes reads, choose another header for correlation, such as `x-correlation-id`, and update the callers that send it.
- If you mount one Routa app in another with `route()`, move the mounted app's route files into the outer app's `src/routes/` folders, using a folder for its path prefix and folder middleware for its own middleware, or run the two apps as separate servers.
