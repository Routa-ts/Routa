---
"@routa-ts/core": patch
---

Say what to use instead when middleware or `createContext` claims a reserved context key.

- Registration errors for middleware that provides `ctx.services`, `ctx.requestId`, `ctx.correlationId`, or `ctx.logger`, or `ctx.auth` when authentication is configured, now give the reason and advice `routa check` gives for `ROUTA_CONTEXT_RESERVED`. They said `Rename the provided key.` before. For `ctx.auth`, which only registration checks, the advice is `Rename the context key. Routa resolves ctx.auth from the request's credential.`
- Request errors for middleware that passes one of the first four keys to `next()`, or a `createContext` that returns `ctx.services`, give the same reason and advice. They said `Rename the context key.` before. For `ctx.services` the advice is `Rename the context key. To share an application dependency, declare it as an application service.`
