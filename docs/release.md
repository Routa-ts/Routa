# Release

Routa uses Changesets with fixed versions for the public packages:

- `@routa-ts/core`
- `@routa-ts/cli`
- `create-routa-ts`

## Normal Flow

1. Add a changeset on a feature branch when user-facing package behavior changes.
2. Merge to `main`.
3. The Release workflow opens a "Version Packages" PR when pending changesets exist.
4. Merge that PR to bump versions and publish to npm.

```sh
pnpm changeset
pnpm version
pnpm release
```

`pnpm release` runs the quality gate, builds packages, checks packed tarballs, and publishes through Changesets.

## GitHub Secrets

The Release workflow expects:

- `GITHUB_TOKEN` (provided automatically)
- `NPM_TOKEN` with publish access to `@routa-ts/*` and `create-routa-ts`

## Local Package Check

```sh
pnpm pack:check
```

The pack check builds all packages, packs the public packages, installs the packed CLI/core into a generated app, then runs:

```sh
routa check
routa build
```

Packed package manifests must not contain `workspace:` dependencies.
