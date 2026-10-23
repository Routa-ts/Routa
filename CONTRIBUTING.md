# Contributing to Routa

Routa is an MIT-licensed project. By contributing, you agree that your contribution is provided under the same license.

## Before You Start

- Use issues for bugs, regressions, and small improvements.
- Use discussions or an issue proposal for large features, public API changes, or behavior changes.
- Keep shipped behavior aligned across implementation, tests, and public documentation.
- Coordinate planned V1 work through the project-local Dex tracker described in `docs/agents/issue-tracker.md`.

## Local Setup

Routa development requires Node.js 24.11+ on the Node 24 line, or Node.js 26+.
Install [Vite Plus](https://viteplus.dev/guide/) before running the commands below.
The repository pins Vite Plus 1.3.0 and uses pnpm 11.9.0 as its underlying dependency
resolver. Use `vp` as the development command interface.

```sh
vp install --frozen-lockfile
vp run verify
```

Commands use the project's pinned Vite Plus toolchain. Existing Node and package-manager
installations work with Vite Plus. Helpers use `vp exec node` to preserve the active Node
version; `vp node` can select a different version from the project's engine range.

`vp run verify` is the complete pre-PR check: formatting, types, unit tests, generated
metadata, example contracts, scaffold diagnostics, and packed-package validation. Use
`vp run quality` for faster formatting, typecheck, and unit-test feedback while iterating.

## Framework tooling

- `vp run check` and `vp run lint` first build workspace declarations and run Astro
  sync for both sites, so clean checkouts have the generated types needed for lint.
  `vp run check` then runs Oxfmt and type-aware Oxlint with compiler diagnostics. The compiler-diagnostics integration is experimental, so `vp run typecheck`
  also runs TypeScript against explicit source and test programs, plus Astro checks.
- `vp run test` runs all framework tests with the Vitest version bundled with Vite Plus.
  Tests always execute. Use `vp exec --filter @routa-ts/core vp test watch` while working
  on one package.
- `vp run build:packages` builds the three published packages with `vp pack` and caches
  their `dist` outputs. Source, manifests, lockfile, and build-config changes invalidate
  the cache. The CLI also fingerprints core and creator outputs; task dependencies
  control ordering, while these inputs prevent stale bundles. Use
  `vp run --no-cache compile` to force a rebuild. Run
  `vp exec node scripts/check-tooling-cache.mjs` separately from other builds to test
  output restoration and dependency invalidation. The probe restores its temporary edit.
- `vp run build` also builds both examples, the docs site, and the design lab.
- `vp run format` uses Oxfmt across the repository, including Markdown, MDX, CSS,
  YAML, JSON, HTML, and Astro. Astro formatting uses the pinned `@astrojs/compiler-rs`.
  Its frontmatter formatting is disabled because the pinned formatter drops comments;
  Astro checks and Oxlint still inspect those scripts.
  Oxlint checks supported scripts, with JavaScript plugins for runtime dependency
  declarations and secret detection. Template/CSS lint coverage differs from Biome;
  Astro checks and site builds remain required.

Vite Plus package configs preserve the published `.js` entry points, including the
CLI's spawned `runtime.js`. Declaration generation uses the existing TypeScript 7
compiler through tsdown's experimental native API integration. Explicit TypeScript
checks and `vp run pack:check` validate the resulting declarations and installed packages.

This tooling is for developing Routa itself. Generated projects keep their existing
TypeScript, Biome, and Vitest scripts and dependency ranges. Astro keeps its own Vite
dependency to avoid mixing plugin types from two Vite distributions.

The [tooling comparison](docs/vite-plus-migration-results.html) records repeated timings,
CPU, memory, dependency counts, and comparison limits. Its numerical evidence is in
`docs/vite-plus-oxc-benchmarks.json`. The earlier hybrid snapshot remains in
`docs/vite-plus-benchmarks.json`. `scripts/benchmark-tooling.mjs` reruns the measurements
against the isolated baseline and environment adjustments recorded there.

## Pull Requests

- Branch from the latest `main`.
- Keep PRs focused on one problem.
- Add or update tests for behavior changes.
- Update docs when public behavior changes.
- Add a changeset when a publishable package changes user-facing behavior.

```sh
vp run changeset
```

## Feature Proposals

Open an issue or discussion before large changes. Include:

- the problem being solved
- the proposed API or behavior
- examples of expected usage
- compatibility or migration concerns

Maintainers may ask for the proposal to be narrowed before implementation.

## Review Expectations

Maintainers prioritize correctness, compatibility, tests, and clear public APIs. A PR may be declined if it expands scope too early, conflicts with v0 goals, or makes unstable behavior look final.
