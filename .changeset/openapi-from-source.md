---
"@routa-ts/cli": minor
---

Generate the current OpenAPI document from source alone. `.routa/openapi-baseline.json` is now comparison data only, so editing only the baseline never changes the generated document.

- `operationId` is generated for every operation as the method plus the PascalCase path, so `GET /users/{id}` is `getUsersId`. This is the rule scaffolding already suggests. Two routes that would generate the same id fail `routa check` with `ROUTA_DUPLICATE_OPERATION_ID`.
- `security` comes only from middleware `openapi.security`, response statuses only from route outcomes and middleware rejects, and `info` is always `Routa API` at version `0.0.0`. `servers` is no longer emitted. A schema exported once but projecting differently as a parameter, a request body, or a response fails with `ROUTA_SCHEMA_COMPONENT_COLLISION` instead of using whichever projection was read first.
- `routa openapi check` now reports an operation's `security` changing. Because the document no longer keeps baseline-only statuses and security, removing a response status or an operation's authentication from source is reported as drift. `routa openapi breaking` keeps its rules, and `--update-baseline` is still the only way to accept drift.

Migration: run `routa openapi check` and review each reported difference: baseline-only response statuses and `security` disappear unless source declares them. `openapi check` does not compare `operationId`, `info`, or `servers`, so review those in the baseline diff: hand-picked `operationId` values rename once, `info.title` falls back to `Routa API`, and `servers` disappears. If the changes are intended, run `routa openapi breaking --update-baseline` and commit the new baseline. Source has no place for a title, version, or `servers` yet.
