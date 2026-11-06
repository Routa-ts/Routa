---
"@routa-ts/cli": patch
---

`routa openapi breaking --update-baseline` now replaces a `.routa/openapi-baseline.json` that contains invalid JSON. Before, it failed with `ROUTA_OPENAPI_BASELINE_INVALID_JSON`, even though that error suggests running it to recreate the baseline.
