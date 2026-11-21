---
"@routa-ts/core": minor
"@routa-ts/cli": minor
---

Reject a correlation header that a configured credential scheme reads.

- `correlation` can no longer name the header an `apiKey()` scheme's `header` or a `custom()` scheme's `transport.header` declares, in any casing. `routa check` reports `ROUTA_CORRELATION_HEADER_CONFLICT` with the scheme's kind and name, such as `The correlation header "X-API-Key" in src/routa.ts names x-api-key, which the apiKey scheme "serviceKey" reads its credential from.`. It compares the scheme declarations it reads from source and never runs an authenticator or extractor; a scheme header it cannot read is reported as `ROUTA_AUTH_CONFIG_UNRESOLVED`, as before. Startup, `createApplication`, and `createHonoApp` throw a `TypeError` naming the scheme before they serve a request. `createApplication` compares the header with the schemes where it already read them, after the services factory, and releases the services the factory constructed when they conflict. `bearer()` and the cookie schemes read `authorization` and `cookie`, which were already rejected.
- A Routa app mounted in another with `route()` shares the outer app's request identity only when both have the same `correlation` setting: both off, or the same header name in any casing. Each app checks its correlation header against its own credential schemes and declared response headers, so a mounted app with another setting could otherwise echo and log a credential or overwrite a header it declares. When the settings differ, the mounted app answers each request it matches with Routa's internal `500` problem. The response keeps its `x-request-id` but no correlation ID is echoed or logged. The mounted app logs `http.error` and reports to its `onRequestError` with the new code `configuration_error` and the new stage `identity`. The error names both settings and no header value.

Migration:

- If `correlation` names a header one of your credential schemes reads, choose another header for correlation, such as `x-correlation-id`, and update the callers that send it.
- If you mount one Routa app in another, give both the same `correlation` setting.
