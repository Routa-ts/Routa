---
"@routa-ts/core": minor
"@routa-ts/cli": minor
---

Add optional Bearer authentication. Configure `authentication` in `createRouta` with one principal schema and a `bearer()` scheme, and every route gets typed `ctx.auth`: anonymous without a credential, authenticated after your authenticator accepts one. A presented credential that is malformed, unsupported, or rejected returns `authenticationFailed` (`401`) with a `WWW-Authenticate` challenge. An inline `requireAuth()` guard returns `authenticationRequired` (`401`) for anonymous requests and narrows `ctx.auth` for the handler. `routa check` reads the scheme facts from source and reports `ROUTA_AUTH_*` diagnostics, and generated OpenAPI declares the security schemes, each operation's security, and both outcomes. Applications without `authentication` generate the same metadata and OpenAPI as before. `routa openapi breaking` no longer reports an operation as requiring authentication when its security includes the empty requirement `{}`.
