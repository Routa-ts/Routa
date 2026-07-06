# Routa Docs

Public documentation site for Routa, built with Astro, Starlight, and Tailwind.

## Project Structure

```text
apps/docs/
  astro.config.mjs
  src/content/docs/
  src/styles/global.css
```

Starlight looks for `.md` or `.mdx` files in the `src/content/docs/` directory. Each file is exposed as a route based on its file name.

## Commands

| Command                   | Action                                           |
| :------------------------ | :----------------------------------------------- |
| `pnpm --filter @routa-ts/docs dev` | Start local docs dev server |
| `pnpm --filter @routa-ts/docs build` | Build docs to `apps/docs/dist` |
| `pnpm --filter @routa-ts/docs preview` | Preview the built docs |
| `pnpm --filter @routa-ts/docs check` | Run Astro checks |

Tailwind theme tokens live in `src/styles/global.css` so future brand changes can stay centralized.
