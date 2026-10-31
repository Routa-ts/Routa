---
"@routa-ts/cli": patch
---

Order generated route metadata and `routa routes` output by UTF-16 code units instead of the machine's locale, so every machine generates the same `.routa` state. Names that differ only in case or use non-ASCII letters can change order: `"Zeta"` now sorts before `"alpha"`. Run `routa generate` and commit the result if your generated files change.
