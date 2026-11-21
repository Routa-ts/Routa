---
"@routa-ts/core": minor
"@routa-ts/cli": minor
---

Reject a correlation header that a configured credential scheme reads, and reject the configured correlation header in outcome headers in TypeScript.

- `correlation` can no longer name the header an `apiKey()` scheme's `header` or a `custom()` scheme's `transport.header` declares, in any casing. `routa check` reports `ROUTA_CORRELATION_HEADER_CONFLICT` with the scheme's kind and name, such as `The correlation header "X-API-Key" in src/routa.ts names x-api-key, which the apiKey scheme "serviceKey" reads its credential from.`. It compares the scheme declarations it reads from source and never runs an authenticator or extractor; a scheme header it cannot read is reported as `ROUTA_AUTH_CONFIG_UNRESOLVED`, as before. Startup, `createApplication`, and `createHonoApp` throw a `TypeError` with the same reason, checked against the validated authentication schemes before the services factory runs. `bearer()` and the cookie schemes read `authorization` and `cookie`, which were already rejected.
- `createApplication` now validates `authentication` before it runs the services factory, so an invalid authentication config fails without constructing services.
- When correlation is on, `.routa/routes.gen.ts` registers the header as `correlationHeader` in `Register`, and TypeScript rejects an outcome or middleware reject that declares it in `headers`, as it already rejects `x-request-id`. `routa check` and registration report it as before.

Migration:

- If `correlation` names a header one of your credential schemes reads, choose another header for correlation, such as `x-correlation-id`, and update the callers that send it.
- Run `routa generate` so `.routa/routes.gen.ts` registers the correlation header.
