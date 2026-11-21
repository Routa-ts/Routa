---
"@routa-ts/core": minor
---

Add `onRequestError`, and record a stable failure code and stage on `http.error`.

- New `onRequestError` option in `createRouta`, `createHonoApp`, and `createApplication`. Routa calls it once for each request that fails unexpectedly or breaks its response contract, with the value that was thrown, unchanged, and a frozen diagnostic: `code`, `stage`, `requestId`, `correlationId` when accepted, `method`, `route`, and `status`. An authenticator, extractor, or services factory that throws passes its own error, not the error Routa answers with. Input validation failures, `415`, `406`, authentication rejections, declared outcomes and middleware rejects of any status, `404`, `405`, and automatic `OPTIONS` are not reported. Startup and cleanup failures keep their owners, and errors from handlers added to the Hono app stay with `app.onError()`.
- Routa chooses the response before it calls `onRequestError` and does not wait for it. A callback that throws or rejects never changes the response; Routa writes one fixed `routa.on_request_error.failed` line to `console.error` per application, without either error's text. The callback runs with `logger: false` and at any logger level. Startup throws a `TypeError` when the option is not a function. `routa check` and `routa generate` never read it, and generated OpenAPI does not change.
- `http.error` now carries `code` (`unexpected_failure` or `contract_violation`) and `stage` (`authentication`, `context`, `input`, `services`, `middleware`, `handler`, or `response`). A failure keeps the stage where it was first thrown, so a handler error that middleware rethrows stays `handler`.
- New types `RequestErrorReporter`, `RequestErrorDiagnostic`, `RequestErrorCode`, and `RequestErrorStage`.

Migration:

- Log queries that match `http.error` data exactly should expect the new `code` and `stage` fields.
