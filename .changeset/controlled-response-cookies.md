---
"@routa-ts/core": minor
"@routa-ts/cli": minor
"create-routa-ts": minor
---

Let a named outcome set and clear cookies through typed handles.

- `createCookie` is a new `@routa-ts/core` export. It declares a cookie once with a `name`, a value `schema` (a string, number, or boolean that does not change values), and static attributes: `httpOnly`, `secure`, `sameSite`, and `path` are required; `domain`, `maxAge`, `expires` (an ISO 8601 date-time string), and `partitioned` are optional. The handle's `set(value)` and `clear()` are pure and return typed effects.
- An outcome lists the handles it may emit in `cookies`. The result's `cookies` is an array of effects for those handles only: it is optional, it is forbidden when the outcome declares none, and an effect for another handle fails TypeScript. A bare handle is optional; write `{ handle: session, required: true }` to require a `set` or `clear` effect for it, which TypeScript checks and Routa enforces in every validation mode. An outcome with a required cookie has no builder. Builders do not take cookies, so return `{ type, data, cookies: [session.set(token)] }`.
- Routa validates, percent-encodes, and sends each effect as its own `Set-Cookie` field, never joined with commas, through the same finalization step as headers. Terminal middleware `rejects` accept `cookies` and share that path. `clear()` keeps the name, domain, path, and security attributes and adds `Max-Age=0` and an epoch `Expires`.
- `SameSite=None` and `Partitioned` require `secure: true`; a `__Secure-` name requires `secure: true`; a `__Host-` name requires `secure: true`, `path: "/"`, and no `domain`. A path starts with `/`, uses printable ASCII without `;`, and has no trailing space; write non-ASCII paths percent-encoded. TypeScript catches these where the literal types allow it, and `createCookie` and `routa check` always do.
- Cookie identity is name, domain, and path. One producer owns an identity in a response, so the same handle twice, or two handles with one identity, fails. The same name with a different domain or path is allowed and warns in `routa check` and at startup. A raw `Set-Cookie` header stays reserved.
- Cookie value parsing and the comparison with your value follow `responseValidation` like the body and headers. Declared handles, required effects, one effect per identity, and safe encoding are checked in every mode.
- `routa check` reads each `createCookie` declaration through relative imports, `export { name }`, aliases, and `export *` re-exports, and reports `ROUTA_RESPONSE_COOKIE_UNRESOLVED`, `_STATIC`, `_ATTRIBUTE`, `_NAME`, `_RULE`, `_VALUE`, `_CONFLICT`, and the `_SCOPE` warning. It accepts a `cookies` field in returned results.
- Generated OpenAPI documents an outcome's cookies through one standard `Set-Cookie` Header Object that lists names and static attributes and says each cookie is a separate repeated field. The header is required, and its description names the cookies, when the outcome declares a required cookie. `openapi check` compares that description, so a changed cookie attribute is drift. It never includes values or examples, and adds no vendor extension.
- Relative imports that name a directory now resolve to its `index.ts` instead of failing.
- A `middleware.ts` file can export middleware declared later with `export { name }`, under an alias, or through `export *`. Generated route metadata now records each middleware by the `middleware.ts` file and the name it exports, so aliased middleware loads at startup. Explicit middleware exports take precedence over wildcard exports with the same name, and overlapping wildcard paths include an exported name once.

Migration: none for existing outcomes. To send a cookie, declare it with `createCookie`, list it in the outcome's `cookies`, and return its effect from the handler instead of writing a `Set-Cookie` header.
