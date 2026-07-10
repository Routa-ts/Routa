# Contributing to Routa

Routa is an MIT-licensed project. By contributing, you agree that your contribution is provided under the same license.

## Before You Start

- Use issues for bugs, regressions, and small improvements.
- Use discussions or an issue proposal for large features, public API changes, or behavior changes.
- Keep v0 changes aligned with the specs in `docs/specs/v0/`.

## Local Setup

Routa development requires Node.js 24+ and pnpm 11.9.0. The repository includes
`.nvmrc` and pins pnpm in `package.json`.

```sh
pnpm install --frozen-lockfile
pnpm verify
```

`pnpm verify` is the complete pre-PR check: formatting, types, unit tests, generated
metadata, example contracts, scaffold diagnostics, and packed-package validation. Use
`pnpm quality` for faster formatting, typecheck, and unit-test feedback while iterating.

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
