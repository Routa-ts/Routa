---
"@routa-ts/cli": minor
"create-routa-ts": minor
---

Project Zod schemas to OpenAPI from source and check them in `routa check`.

- `.describe()` and literal `.meta()` keys (`title`, `description`, `deprecated`, `example`, `examples`, `readOnly`, `writeOnly`, `externalDocs`, and `x-` extensions) now appear on the generated Schema Object at root, nested, inline, and component locations.
- `components.schemas` now comes from source instead of the baseline. `.meta({ id })` names a component, an exported schema a route uses is a component named after its export, and an alias reuses its target's component. Different declarations that claim the same key fail with `ROUTA_SCHEMA_COMPONENT_COLLISION`.
- `z.discriminatedUnion` generates `oneOf` with `discriminator.propertyName`, and `z.intersection` and `.and()` generate `allOf`, folding plain object members into one object. Scaffolding maps `anyOf` to `z.union` and a discriminated `oneOf` to `z.discriminatedUnion`.
- Input schemas document the incoming side: `.default()` and `.catch()` make a property optional, and `.transform()` or `.pipe()` after a readable schema documents that schema. `z.preprocess()` and a leading `z.transform()` print a `ROUTA_SCHEMA_OPAQUE_INPUT` warning.
- `routa check` now fails on schemas it cannot read (`ROUTA_SCHEMA_UNSUPPORTED`, `ROUTA_SCHEMA_UNRESOLVED`), metadata misuse (`ROUTA_SCHEMA_META_*`, `ROUTA_SCHEMA_REGISTRY`), and response schemas that change values (`ROUTA_RESPONSE_SCHEMA_MUTATION`). These replace the `ROUTA_OPENAPI_UNSUPPORTED_ZOD` warning, and generation no longer emits empty schemas for them.
- `routa openapi check` compares schemas by content, so inline and `$ref` spellings of the same schema are not drift.
- New projects declare `zod@^4.6.7`, matching the `@routa-ts/core` peer.

Migration: run `routa check` and fix each reported schema. Replace response transforms, defaults, and coercions with wire-ready handler values. Then run `routa openapi check`; if it reports drift from corrected projections, such as query helpers now documented as strings or baseline-only component details, review the change and accept it with `routa openapi breaking --update-baseline`.
