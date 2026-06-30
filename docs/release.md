# Release

Routa uses Changesets with fixed versions for the public packages:

- `@routa/core`
- `@routa/cli`
- `create-routa`

## Normal Flow

```sh
pnpm changeset
pnpm version
pnpm release
```

`pnpm release` runs the quality gate, builds packages, checks packed tarballs, and publishes through Changesets.

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
