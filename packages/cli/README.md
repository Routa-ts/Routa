# @routa-ts/cli

Command-line tools for Routa, a schema-first, OpenAPI-aware REST framework for new TypeScript APIs.

The `routa` command checks route contracts, builds generated route metadata, runs the development server, and scaffolds projects from OpenAPI files.

## Install

```sh
pnpm add -D @routa-ts/cli
```

## Usage

```sh
pnpm exec routa check
pnpm exec routa build
pnpm exec routa dev
pnpm exec routa openapi check
```

## Create A Project

For new applications, use the project scaffolder:

```sh
pnpm create routa-ts@latest
```

## Links

- Repository: https://github.com/joseAcevesG/Routa
- Documentation: https://github.com/joseAcevesG/Routa/tree/main/docs
