# Explicit API evolution checks preserve application ownership

Routa V1 will compare the current source-derived HTTP contract against an explicitly accepted OpenAPI snapshot, preserving known facts and reporting unsupported changed relationships as unresolved. Findings are informational by default; an explicit CI flag fails on breaking or unresolved changes, while malformed inputs always fail and baseline acceptance remains a separate explicit command.

Folder deprecation inherits through ordinary route ancestry into one typed effective contract and standard lifecycle headers, without retiring routes or taking ownership of application migration policy. These choices favor explainable bounded checks and developer-controlled enforcement over a universal compatibility guarantee or implicit release gate. Runtime implementation remains pending.
