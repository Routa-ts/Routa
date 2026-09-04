# Zod 4.5 and advanced response contracts

Status: research input for Wayfinder, not an accepted decision

Checked: 2026-09-01

## Recommendation

Raise Routa's tested and peer dependency floor from `zod@^4.4.3` to `zod@^4.5.4` as part of advanced response contracts, then use Zod's native schema composition rather than adding Routa-specific `anyOf()` or `allOf()` helpers.

- `z.union(...)` remains the source-level "any" composition.
- `z.intersection(...)` / `.and(...)` remains the source-level "all" composition.
- Routa should promise equivalent OpenAPI 3.1 semantics, not a particular emitted keyword. Zod 4.5 may represent a simple union as a `type` array instead of `anyOf`, and may fold compatible object intersections into one object instead of `allOf`.
- The dependency update does not make Routa support composition automatically. Routa's current source analyzer has its own OpenAPI projection: it handles `z.union()` but not `z.intersection()`, while OpenAPI-to-source scaffolding rejects `allOf`. Those Routa layers still need explicit implementation and tests.
- Do not base the public contract or scaffold on `z.fromJSONSchema()` yet. Zod marks it experimental, and it already understood `anyOf`/`oneOf`/`allOf` in 4.4.3; it is not the new 4.5 capability.

## What 4.5 changes

Zod 4.5 was released on 2026-08-28. The current stable package checked for this note is 4.5.4, not 4.5.0. The repository's `^4.4.3` peer range already admits 4.5.x, but the lockfile and tested floor remain 4.4.3. If Routa calls a 4.5 API, it must raise the minimum peer version as well as refresh its development and example dependencies. ([announcement](https://zod.dev/blog/zod-4-5), [4.5.4 package metadata](https://github.com/colinhacks/zod/blob/v4.5.4/packages/zod/package.json))

The directly relevant changes are:

1. **Safer JSON Schema composition.** `z.toJSONSchema()` now compacts only unconstrained `anyOf` branches such as `{type: "string"}` and `{type: "number"}` into an equivalent JSON Schema type array. Constrained branches, references, metadata, and `oneOf` remain explicit. ([implementation rationale](https://github.com/colinhacks/zod/commit/6c77d028))
2. **Correct object intersections.** Zod previously emitted two closed object schemas under `allOf`; each rejected the other member's properties, so the generated schema accepted nothing even though Zod parsing succeeded. Zod 4.5 folds compatible object intersections into one closed object over the combined keys. Intersections with constraints it cannot safely fold remain `allOf`. ([implementation rationale](https://github.com/colinhacks/zod/commit/7b612b53))
3. **Runtime input/output projections.** New `z.input(schema)` and `z.output(schema)` functions project nested pipes and codecs onto their input or output side. This can help Routa distinguish a JSON wire schema from a handler-facing value schema if response codecs are deliberately supported. It is not needed for ordinary JSON schemas whose input and output types are identical. ([4.5 announcement](https://zod.dev/blog/zod-4-5#zinput--zoutput))
4. **Faster validation is available but orthogonal.** `z.compile()` and `z.validate()` may improve response-validation performance, but they do not change response-contract expressiveness. They should not enter this decision without a Routa benchmark and an explicit runtime policy. ([4.5 announcement](https://zod.dev/blog/zod-4-5#zcompile))

In a local isolated comparison, the same schemas produced these shapes:

```text
zod 4.4.3 union:        { anyOf: [{ type: "string" }, { type: "number" }] }
zod 4.5.4 union:        { type: ["string", "number"] }

zod 4.4.3 intersection: { allOf: [closed object A, closed object B] }
zod 4.5.4 intersection: one closed object with A and B properties
```

These are exporter changes, not new composition constructors. Zod has long described unions as logical OR and intersections as logical AND; it recommends object extension when the desired operation is simply merging object shapes. ([schema API](https://zod.dev/api#intersections))

## Metadata, registries, codecs, and output schemas

- Metadata and registries predate 4.5. `z.globalRegistry`, `.meta()`, and custom registries can feed title, description, examples, IDs, and other fields into `z.toJSONSchema()`. They are useful if Routa eventually delegates schema projection to Zod, but upgrading alone does not connect them to Routa's current AST-based emitter. Metadata overrides generated JSON Schema keywords, so Routa would need a policy rather than blindly accepting arbitrary overrides. ([metadata docs](https://zod.dev/metadata), [JSON Schema metadata behavior](https://zod.dev/json-schema#metadata))
- Codecs predate 4.5 (introduced in 4.1). They model a network-friendly input and richer application output, with `encode` converting output back to input. Supporting them in responses would be a separate serialization decision: the current `{ type, data }` response model uses the schema output type, while runtime validation currently parses forward. Do not silently treat 4.5's projection helpers as codec support. ([codec docs](https://zod.dev/codecs))
- `z.toJSONSchema()` defaults to the schema's output side and accepts `io: "input"` for the input side. Routa must explicitly choose the wire side if it adopts Zod's exporter. ([JSON Schema I/O docs](https://zod.dev/json-schema#io))

## Upgrade risks and proof required

Zod 4.5 includes soundness fixes that may reject values accepted by 4.4, including stricter RFC 3339 datetimes, Unicode code-point string lengths, record/intersection behavior, `__proto__` stripping, and stricter string formats. Version 4.5.4 also fixes a 4.5.0 regression where cycle discovery could invoke a default factory early. Pin the implementation work to at least 4.5.4 and run Routa's full verification plus focused behavior tests for response schemas, unions, intersections, defaults, codecs/pipes, OpenAPI generation, and scaffold round trips. ([4.5 bug-fix notes](https://zod.dev/blog/zod-4-5#bug-fixes), [4.5.4 fix](https://github.com/colinhacks/zod/commit/84e416fb))

## Decision wording to carry forward

> Advanced JSON response bodies accept Zod composition through `z.union()` and `z.intersection()` / `.and()`. Routa targets Zod `^4.5.4` and projects those schemas to semantically equivalent OpenAPI 3.1, without guaranteeing `anyOf` or `allOf` as the literal output shape. Routa adds no parallel composition API. Codec-backed response serialization remains outside this decision unless separately approved.
