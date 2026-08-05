# Commit deterministic Routa state

Routa projects commit deterministic `.routa/` metadata because editors, runtime loading, regeneration checks, CI, and reviewers must share the same accepted contract state. This accepts generated-file churn in exchange for reviewable API changes, reproducible checks, and safe regeneration.
