---
"@routa-ts/core": minor
---

Add typed response builders to route handlers. Return `response.ok(data)` for an outcome named `ok`, with methods and payload types inferred from the route's `responses`. Builders create ordinary named results without sending a response; existing `{ type, data }` returns remain supported.

This is a pre-1.0 source-breaking change for code that manually constructs `RouteHandlerArgs` or directly calls a route's `run`: the arguments now require `response`. Supply one builder per declared outcome, each returning `{ type, data }` for its outcome. For example, an `ok` outcome needs `ok: (data) => ({ type: "ok", data })`. Use `ResponseBuilders<typeof route.responses>` to type a test's builder object, or pass `typeof route.responses` as the third type parameter of `RouteHandlerArgs` when annotating the complete arguments. Routa supplies these builders automatically during request execution, so existing handlers do not need migration.
