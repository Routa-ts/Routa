# Zod 4.5 and OpenAPI metadata integration

Research date: 2026-09-01. Versions are current npm `latest` versions on that date.

## Recommendation

Keep Zod as a consumer-provided peer dependency and raise Routa's floor to `zod@^4.5.4`. Do not bundle a private Zod copy or introduce `@routa-ts/core/zod` as the canonical import.

Make native Zod 4 `.meta()` the Routa authoring surface for schema metadata. Use `id` for reusable component identity and ordinary OpenAPI/JSON Schema fields such as `title`, `description`, `deprecated`, `example`, and `examples`. Routa already knows whether a schema is a path parameter, query parameter, header, request body, or response from the route contract, so users should not repeat that placement in library-specific `param` metadata.

Do not adopt `.openapi()` or require an initialization call. If implementation work shows that native `z.toJSONSchema()` needs too much OpenAPI-specific normalization, use `zod-openapi` internally as the converter; it uses native `.meta()` and does not patch Zod. Do not use `@hono/zod-openapi`: it is an alternate Hono route-contract and registry layer, not a schema converter suited to Routa's existing contract.

This requires a separate generator design decision. Routa currently parses Zod syntax from TypeScript AST without loading schema objects. Native Zod and all three libraries below consume live schema instances, so merely installing one will not make metadata or new Zod constructs appear in Routa's generated OpenAPI.

## Current Routa behavior

- `@routa-ts/core` declares `zod@^4.4.3` as a peer and dev dependency; it does not export Zod. Generated projects and examples depend on and import `zod` directly. This already follows Zod's library-author guidance to let users bring their own Zod. ([core package](../packages/core/package.json), [Zod library-author guidance](https://zod.dev/library-authors#how-to-configure-peer-dependencies))
- Core public types and the Hono adapter import Zod directly. There is no `./zod` package export. ([core package exports](../packages/core/package.json), [core types](../packages/core/src/index.ts), [Hono adapter](../packages/core/src/hono.ts))
- The CLI's OpenAPI generator reads `schemas.ts` and route files as source, then maps recognized call expressions through its own `SchemaReader`. `meta` is currently a passthrough call, so `.meta({...})` is accepted but its metadata is discarded. `z.union()` becomes `anyOf`; intersection is not implemented. ([OpenAPI generator](../packages/cli/src/openapi.ts))
- This static design means runtime converters cannot be dropped in without deciding how Routa obtains live schemas while keeping checks deterministic and avoiding arbitrary application execution.

## Compatibility matrix

| Option | Current version | Declared Zod support | Metadata and registry model | Zod 4.5.4 status | Fit for Routa |
| --- | ---: | --- | --- | --- | --- |
| Native Zod | 4.5.4 | N/A | `.meta()` writes to `z.globalRegistry`; custom `z.registry()` instances are supported. `z.toJSONSchema()` reads metadata, supports input/output projection, registries, refs, overrides, and an OpenAPI 3.0 target. | Exact version under consideration. | Best public surface and smallest dependency. It emits schema documents, not a complete OpenAPI operation model; Routa must keep assembling paths, operations, responses, and components. |
| `@asteasolutions/zod-to-openapi` | 9.1.0 | peer `zod@^4.0.0` | `extendZodWithOpenApi(z)` patches the supplied Zod classic instance with `.openapi()`. `OpenAPIRegistry` collects paths/components. Since v8 it can also read native `.meta()`; most uses do not require patching. | Semver-compatible. Its current source tests against Zod 4.0.5, so there is no explicit upstream 4.5.4 test claim. An isolated 4.5.4 smoke test succeeded and emitted literal `anyOf`/`allOf`. | Viable converter, but `.openapi()` adds ordering, side-effect, and instance-identity concerns that Routa does not need. Its separate route registry overlaps Routa. |
| `zod-openapi` | 6.0.2 | peer `zod@^4.0.0`; Node >=22.14 | Uses native `.meta()` with type augmentation; no monkey patch or setup. `createDocument()`/`createSchema()` resolve schemas and components, with OpenAPI-specific `param`, `header`, `override`, `outputId`, and component metadata. | Semver-compatible. Current source tests against Zod 4.4.3, not explicitly 4.5.4. An isolated 4.5.4 smoke test succeeded; it preserved 4.5's equivalent union/intersection output instead of forcing literal keywords. | Best fallback converter because its public schema syntax matches native Zod and Routa can avoid adopting its full document model. Its Node floor is below Routa's current Node 24 floor. |
| `@hono/zod-openapi` | 1.6.1 | peers `zod@^4.0.0`, `hono>=4.10.0` | Imports Zod, calls `extendZodWithOpenApi(z)` at module load, and re-exports that patched `z`. Each `OpenAPIHono` owns an `OpenAPIRegistry`. It depends on `@asteasolutions/zod-to-openapi`. | Semver-compatible. Current source tests against Zod 4.2.1, not explicitly 4.5.4. Its re-exported `.openapi()` parsed successfully in an isolated 4.5.4 smoke test. | Poor fit. It is the exact re-export pattern being considered, but it also replaces Routa's route contract, response typing, registry, and app class. |

Package versions and peer ranges come from the exact published package metadata: [`@asteasolutions/zod-to-openapi@9.1.0`](https://unpkg.com/@asteasolutions/zod-to-openapi@9.1.0/package.json), [`zod-openapi@6.0.2`](https://unpkg.com/zod-openapi@6.0.2/package.json), and [`@hono/zod-openapi@1.6.1`](https://unpkg.com/@hono/zod-openapi@1.6.1/package.json). A peer range of `^4.0.0` accepts 4.5.4, but it is not evidence that upstream tested that exact release. The smoke results above establish basic local compatibility, not exhaustive support.

## Why not make Zod internal or re-export it?

Zod's official guidance for libraries built on Zod is a `zod` peer dependency so consumers bring one compatible installation. The recommended library implementation import is `zod/v4/core`; public applications can continue importing classic Zod from `zod`. ([Zod library-author guidance](https://zod.dev/library-authors))

Making Zod a normal dependency creates a realistic two-copy state when an application or another integration also depends on Zod. A re-export does not satisfy the `zod` peer dependency declared by the OpenAPI packages: package managers resolve peers by package name, not by an API re-export. Users combining Routa with those packages would still install `zod`.

Two copies are especially fragile for `.openapi()`: `extendZodWithOpenApi(z)` modifies the prototype belonging to the particular classic Zod namespace passed to it. Schemas built from another copy or loaded before the extension can lack the method or its metadata-preserving wrappers. The library itself instructs users to call the extension once in a common entry point and to preserve the side effect under tree shaking. ([extension documentation](https://github.com/asteasolutions/zod-to-openapi#the-openapi-method), [extension source](https://github.com/asteasolutions/zod-to-openapi/blob/master/src/zod-extensions.ts))

`@hono/zod-openapi` avoids that ambiguity by importing, extending, and re-exporting one `z`, then requiring users to import it from Hono's package. Its source demonstrates the pattern, but also demonstrates the coupling: the same module exports `OpenAPIHono`, its route types, its registry, and the patched Zod namespace. A reported esbuild code-splitting failure also shows why a patch-through re-export needs real bundled-entry tests: types and ordinary tests passed while production failed with `.openapi is not a function`. ([Hono usage](https://hono.dev/examples/zod-openapi), [Hono source](https://github.com/honojs/middleware/blob/main/packages/zod-openapi/src/index.ts#L761-L762), [Hono issue #2051](https://github.com/honojs/middleware/issues/2051))

Native `.meta()` avoids prototype patching. Zod associates metadata with the schema instance in a registry; `.meta()` is shorthand for registering in `z.globalRegistry`. Zod methods are immutable, so metadata attachment order still matters: methods called after `.meta()` create a new schema instance without that metadata. ([metadata and registries](https://zod.dev/metadata))

## Native Zod 4.5 as the baseline

Zod 4 provides the pieces Routa needs without a `.openapi()` extension:

- strongly typed registries plus `z.globalRegistry`;
- `.meta()`/`.register()` on every schema;
- `z.toJSONSchema()` with metadata, refs, input/output projection, cycle/reuse policy, and override hooks;
- native union and intersection conversion, improved in 4.5;
- arbitrary metadata copied to generated JSON Schema.

Sources: [Zod metadata](https://zod.dev/metadata), [JSON Schema conversion](https://zod.dev/json-schema), and [Zod 4.5 release](https://zod.dev/blog/zod-4-5).

Native conversion does not replace Routa's OpenAPI model. Routa still owns named outcomes, status merging, request/response placement, headers, cookies, diagnostics, generated metadata, and baseline checks. It also needs a defined policy for `io: "input"` on request schemas versus output projection on responses and for unrepresentable transforms/codecs.

Avoid making `z.globalRegistry` Routa's only source of component discovery. It is process-global, so independent documents can collide on `id`, and unrelated imported schemas can enter the same registry. Prefer a Routa-owned registry or a deterministic set of schemas reachable from route contracts; `.meta()` can remain the authoring convenience. Zod explicitly recommends custom registries for advanced cases and documents registry-based multi-schema conversion. ([registry guidance](https://zod.dev/metadata#custom-registries), [registry conversion](https://zod.dev/json-schema#registries))

## Decision impact

If accepted, the advanced-response decision should say:

1. Routa raises its peer, dev, generated-project, example, and tested floor to `zod@^4.5.4`.
2. Schemas continue to import `z` from `zod`; Routa does not expose `@routa-ts/core/zod`.
3. Native `.meta()` is the supported schema-level documentation surface. Routa does not add or initialize `.openapi()`.
4. The implementation must add focused 4.5.4 tests for unions, intersections, metadata, refs/components, input/output projection, and OpenAPI/scaffold round trips.
5. Before promising metadata output, choose and test the live-schema conversion boundary. The current AST converter silently drops `.meta()` values, so dependency changes alone are incomplete.
