# Contributing to Routa

Routa is an MIT-licensed project. By contributing, you agree that your contribution is provided under the same license.

## Before You Start

- Use issues for bugs, regressions, and small improvements.
- Use discussions or an issue proposal for large features, public API changes, or behavior changes.
- Keep shipped behavior aligned across implementation, tests, and public documentation.
- Coordinate planned V1 work through the project-local Dex tracker described in `docs/agents/issue-tracker.md`.

## Local Setup

Routa development requires Node.js 24.11+ on the Node 24 line, or Node.js 26+,
and pnpm 11.9.0. The repository includes
`.nvmrc` and pins pnpm in `package.json`.

```sh
pnpm install --frozen-lockfile
pnpm verify
```

The repository pins Vite Plus in its development dependencies. Commands use that local
version; a global installation is optional. Use `pnpm exec vp` for direct commands.
The existing Node manager and pnpm setup work with Vite Plus.

`pnpm verify` is the complete pre-PR check: formatting, types, unit tests, generated
metadata, example contracts, scaffold diagnostics, and packed-package validation. Use
`pnpm quality` for faster formatting, typecheck, and unit-test feedback while iterating.

## Framework tooling

- `pnpm check` runs Oxfmt and Oxlint together with type-aware rules and compiler
  diagnostics. The compiler-diagnostics integration is experimental, so `pnpm typecheck`
  also runs TypeScript against explicit source and test programs, plus Astro checks.
- `pnpm test` runs all framework tests with the Vitest version bundled with Vite Plus.
  Tests always execute. Use `pnpm --filter @routa-ts/core exec vp test watch` while working
  on one package.
- `pnpm build:packages` builds the three published packages with `vp pack` and caches
  their `dist` outputs. Source, manifests, lockfile, and build-config changes invalidate
  the cache. Use `pnpm exec vp run --no-cache compile` to force a rebuild.
- `pnpm build` also builds both examples, the docs site, and the design lab.
- `pnpm format` formats framework files with Oxfmt. Biome still owns formatting and
  linting for docs, design, and examples. It also checks framework dependency declarations
  and secrets, which are not replaced by the current Oxlint configuration.

Vite Plus package configs preserve the published `.js` entry points, including the
CLI's spawned `runtime.js`. Declaration generation uses the existing TypeScript 7
compiler through tsdown's experimental native API integration. Explicit TypeScript
checks and `pnpm pack:check` validate the resulting declarations and installed packages.

This tooling is for developing Routa itself. Generated projects keep their existing
TypeScript, Biome, and Vitest scripts and dependency ranges. Astro keeps its own Vite
dependency to avoid mixing plugin types from two Vite distributions.

## Pull Requests

- Branch from the latest `main`.
- Keep PRs focused on one problem.
- Add or update tests for behavior changes.
- Update docs when public behavior changes.
- Add a changeset when a publishable package changes user-facing behavior.

```sh
pnpm changeset
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
