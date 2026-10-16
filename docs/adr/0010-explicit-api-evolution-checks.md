# Explicit API evolution checks preserve application ownership

Routa V1 will use `routa openapi breaking` to compare the current source-derived HTTP contract against an explicitly accepted OpenAPI snapshot, preserving known facts and reporting unsupported changed relationships as unresolved. Findings will be informational by default; `--fail-on-breaking` will enable CI failure on breaking or unresolved changes, while malformed inputs will always fail and baseline acceptance will remain a separate explicit command.

The shipped V0 comparison commands return exit code `1` for detected drift in `routa openapi check` and detected breaks in `routa openapi breaking`. When this V1 decision is implemented, CI that gates on breaking changes must add `--fail-on-breaking`; `routa openapi check` will retain its drift failure behavior.

Folder deprecation inherits through ordinary route ancestry into one typed effective contract and standard lifecycle headers, without retiring routes or taking ownership of application migration policy. These choices favor explainable bounded checks and developer-controlled enforcement over a universal compatibility guarantee or implicit release gate. Runtime implementation remains pending.
