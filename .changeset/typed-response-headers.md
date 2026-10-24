---
"@routa-ts/core": minor
"@routa-ts/cli": minor
"create-routa-ts": minor
---

Let a named outcome declare its response headers.

- An outcome's `headers` is a Zod object keyed by lowercase header names with string, number, or boolean values (or literals and enums of them). The handler result's `headers` is required when any declared header is required, optional when all are, and forbidden when the outcome declares none. `response.name(data, headers)` and, for a bodyless outcome, `response.name(headers)` build the result. Outcomes without `headers` keep their current source.
- Routa serializes each value to one header string, and bodyless outcomes can send their declared headers without receiving content headers. Declared names, required headers, and safe values (no line breaks, no surrounding whitespace, finite numbers) are checked in every mode. Zod parsing and the comparison with your value follow `responseValidation` like the body, so a header schema must not change values either.
- A header has one owner. Routa owns `content-type`, `content-length`, `transfer-encoding`, `connection`, and `set-cookie`, and with `lifecycleHeaders` on it owns `deprecation`, `sunset`, and the successor `link`. A declaration that claims one, declares a name that is not lowercase, declares two names that differ only in case, or declares a value that is not a string, number, or boolean fails in TypeScript, in `routa check` (`ROUTA_RESPONSE_HEADER_NAME`, `_COLLISION`, `_RESERVED`, `_LIFECYCLE`, `_VALUE`), and when the app registers the route. A result that writes an undeclared header, the same header in two cases, or a header a lifecycle header also writes fails as invalid handler output instead of merging or overwriting.
- Declared headers become Header Objects in the generated OpenAPI response, with the header's schema, `required`, and description. All response headers, declared and lifecycle, now leave through one finalization step.
- `routa check` accepts a `headers` field in returned results next to `type` and `data`.

Migration: none for existing outcomes. If an outcome already declared nothing, nothing changes. To send a header such as `etag` or `retry-after`, declare it in the outcome's `headers` and return it from the handler instead of setting it elsewhere.
