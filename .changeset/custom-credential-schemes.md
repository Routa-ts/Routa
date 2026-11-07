---
"@routa-ts/core": minor
"@routa-ts/cli": minor
---

Add `custom()` credential schemes for credentials the built-in schemes do not read, such as HTTP Basic or a client certificate a trusted proxy forwards. A custom scheme declares one transport (a header, one `Authorization` auth-scheme, or a cookie), a static challenge override, and public OpenAPI metadata. Its optional synchronous `extract` receives only that value, and the credential it returns reaches `authenticate` typed. Custom schemes share priority, strict mode, `requireAuth` scheme lists, principal parsing, typed `ctx.auth`, challenges, and OpenAPI security with the built-in schemes. `routa check` and startup reject a transport another scheme already reads with `ROUTA_AUTH_TRANSPORT_OVERLAP`, and OpenAPI metadata that disagrees with the transport. An `Authorization` auth-scheme a custom scheme reads is not an unsupported credential.
