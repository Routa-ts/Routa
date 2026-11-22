---
"@routa-ts/core": patch
---

Say what to use instead when middleware or `createContext` claims a reserved context key.

- The errors that registration and requests raise for `ctx.services` and `ctx.auth` now end with the advice `routa check` gives for `ROUTA_CONTEXT_RESERVED`: `Rename the context key. To share an application dependency, declare it as an application service.` and `Rename the context key. Routa resolves ctx.auth from the request's credential.` Registration said `Rename the provided key.` before.
