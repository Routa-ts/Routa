---
"@routa-ts/core": minor
---

Add typed response builders to route handlers. Return `response.ok(data)` for an outcome named `ok`, with methods and payload types inferred from the route's `responses`. Builders create ordinary named results without sending a response; existing `{ type, data }` returns remain supported.
