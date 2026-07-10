# Routa Docs

Public site for Routa: Lattice-branded marketing landing at `/`, Starlight docs under `/docs/`.

## Project Structure

```text
apps/docs/
  astro.config.mjs
  src/pages/index.astro          # Schematic marketing landing (Lattice)
  src/styles/landing.css         # Landing-only styles
  src/content/docs/docs/         # Starlight pages → /docs/*
  src/styles/global.css          # Lattice @theme tokens for Starlight
```

## Commands

| Command | Action |
| --- | --- |
| `pnpm --filter @routa-ts/docs dev` | Start local site (landing + docs) |
| `pnpm --filter @routa-ts/docs build` | Build to `apps/docs/dist` |
| `pnpm --filter @routa-ts/docs preview` | Preview the build |
| `pnpm --filter @routa-ts/docs check` | Run Astro checks |

Landing composition: **Schematic** (chosen from `apps/design` landings review).
