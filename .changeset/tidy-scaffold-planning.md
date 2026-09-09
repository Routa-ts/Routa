---
"@routa-ts/cli": patch
---

Use one scaffold plan for preview and file application. Report locally modified stale files as conflicts in previews and reject known conflicts before writing or deleting generated files.

Reject regeneration of existing managed source files when their manifest hash is missing, protecting both retained and stale files. Preserve regeneration of framework-owned route metadata and the manifest.
