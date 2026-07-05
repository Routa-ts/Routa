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
pnpm run version
pnpm run release
```

`pnpm run release` builds the local CLI shim used by workspace examples, runs the quality gate, builds packages, checks packed tarballs, and publishes through Changesets.

## GitHub Secrets

The Release workflow uses npm trusted publishing with GitHub Actions OIDC. Each
public package must have a trusted publisher configured on npm:

- GitHub organization/user: `Routa-ts`
- Repository: `Routa`
- Workflow filename: `release.yml`
- Allowed action: `npm publish`

The workflow requires `id-token: write` so npm can exchange the GitHub Actions
OIDC token for a short-lived publish credential. It does not require an
`NPM_TOKEN` secret for publishing.

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
