---
"@routa-ts/core": minor
"@routa-ts/cli": minor
---

Reject a correlation header that a configured credential scheme reads.

- `correlation` can no longer name the header an `apiKey()` scheme's `header` or a `custom()` scheme's `transport.header` declares, in any casing. `routa check` reports `ROUTA_CORRELATION_HEADER_CONFLICT` with the scheme's kind and name, such as `The correlation header "X-API-Key" in src/routa.ts names x-api-key, which the apiKey scheme "serviceKey" reads its credential from.`. It compares the scheme declarations it reads from source and never runs an authenticator or extractor; a scheme header it cannot read is reported as `ROUTA_AUTH_CONFIG_UNRESOLVED`, as before. Startup, `createApplication`, and `createHonoApp` throw a `TypeError` naming the scheme before they serve a request. `createApplication` compares the header with the schemes where it already read them, after the services factory, and releases the services the factory constructed when they conflict. `bearer()` and the cookie schemes read `authorization` and `cookie`, which were already rejected.

Migration:

- If `correlation` names a header one of your credential schemes reads, choose another header for correlation, such as `x-correlation-id`, and update the callers that send it.
