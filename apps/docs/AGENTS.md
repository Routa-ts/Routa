# Routa Documentation Standard

This file governs every page under `src/content/docs/docs/`. Read it before adding or
editing documentation. The goal is one predictable shape per section so readers build a
habit instead of re-learning each page.

## Development

When starting the dev server, use background mode:

```
astro dev --background
```

Manage the background server with `astro dev stop`, `astro dev status`, and `astro dev logs`.

Before opening a pull request, run `pnpm --filter @routa-ts/docs build`. A broken internal
link fails the build.

## Purpose of a Page

A page answers one question for one reader in one sitting. If you cannot write that
question in a single sentence, split the page. The title is the subject of the answer.
The frontmatter `description` is the one-sentence promise.

## Required Frame

Every page uses this frame, regardless of which structure it follows.

1. **Frontmatter** with `title` and `description`.
   - `title` is Title Case and names the same thing as the sidebar label in
     `astro.config.mjs`, which stays in sentence case.
   - `description` is one sentence, under about 120 characters, ending in a period. Never
     begins with "This page".
2. **Lede** of one to three sentences directly after the imports and before any heading.
   It states what the thing is and why it exists. Never open with a heading or a code block.
3. **Body**, shaped by one of the five structures below.
4. **Status note** when behavior is limited or deferred, using
   `<Aside type="caution" title="…">`. Every feature page must say whether the feature is
   implemented, partial, or deferred. Silence here is the most common documentation bug.
5. **Next steps** as a closing `##` section with two to four `<LinkCard>` entries inside a
   `<CardGrid>`. Links point forward in the reader's journey, never back to the page they
   most likely came from.

## Voice and Grammar

- Second person, present tense, active voice. "Routa validates the route graph", not
  "the route graph will be validated".
- Say what Routa does, then what the reader does.
- Never use "simply", "just", "easy", "powerful", or "seamless".
- Headings use Title Case. Use only `##` and `###`. A page that needs `####` is two pages.
- Define a term the first time it appears on a page, then link to the canonical
  definition instead of re-explaining it.

## Code Rules

- Every code block is complete enough to paste and run. Include imports the first time a
  symbol appears on the page.
- Add a `title` to code fences that represent a file:

  ````
  ```ts title="src/routes/users/route.ts"
  ````

- Indent with tabs inside code blocks, matching the repository Biome configuration.
- Show the output or diagnostic when a command produces one. A command without its
  expected result is half a doc.

### Package Manager Commands

Never hardcode a single package manager and never use a `<package-manager>` placeholder.
Every shell command a reader runs in their own project must offer npm, pnpm, Yarn, and Bun
through the shared component:

```mdx
import PackageManagers from "@components/PackageManagers.astro";

<PackageManagers type="run" args="dev" />
```

Supported `type` values:

| `type`    | Purpose                        | Example props                                     |
| --------- | ------------------------------ | ------------------------------------------------- |
| `create`  | Scaffold a new Routa project   | `<PackageManagers type="create" />`                |
| `install` | Install existing dependencies  | `<PackageManagers type="install" />`               |
| `add`     | Add runtime dependencies       | `<PackageManagers type="add" args="hono zod" />`   |
| `add-dev` | Add dev dependencies           | `<PackageManagers type="add-dev" args="vitest" />` |
| `run`     | Run a `package.json` script    | `<PackageManagers type="run" args="dev" />`        |
| `exec`    | Run the `routa` binary         | `<PackageManagers type="exec" args="check" />`     |

Use `env` for a leading environment prefix: `<PackageManagers type="run" args="start" env="HOST=0.0.0.0 PORT=3000" />`.

All tabs share `syncKey="pkg"`, so a reader picks their package manager once per site visit.

Plain ` ```sh ` blocks remain correct for commands that are not package-manager specific,
such as `node --version`, `git init`, or repository-only `pnpm --filter` commands in the
Examples and Community sections.

## Coverage Rules

"Correctly documented" means all of the following hold. Verify them when adding a feature
to `@routa-ts/core`, `@routa-ts/cli`, or `create-routa-ts`.

- Every exported symbol from every `@routa-ts/core` entry point (`.`, `./hono`,
  `./logger`, `./query/helpers`) appears in Reference with a signature, its options, and
  one example.
- Every CLI command and every flag appears in the CLI reference, and each appears in at
  least one guide that shows it inside a real workflow.
- Every `ROUTA_*` diagnostic code the CLI can emit appears in Diagnostics with its cause
  and its fix.
- Every file Routa generates or owns appears in Generated Files.
- Every feature is reachable from the sidebar within two clicks of Start.

## Cross-Linking

Concepts explain, Guides do, Reference lists. A guide links down to reference detail
instead of repeating it. Reference links up to a guide for context. State a fact once, in
the layer that owns it.

## Page Structures

Each sidebar section uses exactly one structure.

### A — Answer First

Lede, smallest working example, "How It Works" prose about that example, rules or
behavior detail, limits, next steps. The reader gets something correct in the first
screen and detail only if they keep scrolling.

### B — Task Recipe

Lede stating the goal, "Before You Start" prerequisites, `<Steps>` with one action per
step, "Verify" showing the output that proves it worked, "Troubleshooting" as a
problem/fix table, next steps.

### C — Contract Reference

Lede, then one `##` per symbol or command containing a signature block, a parameters
table, the return value, one example, and the errors it can raise. Close with related
links. Uniform and scannable so readers can jump by heading.

### D — Mental Model

Lede, "The Model" in plain language before any code, a `<FileTree>` or diagram showing
the shape, "Anatomy" walking through each part, "Guarantees" listing what Routa promises,
"What You Own" listing what the application owns, next steps.

### E — Decision Page

Lede framing the situation, "Options" with each alternative as a `###` and an honest
tradeoff, "What Routa Does", "Consequences", "When This Changes" for version boundaries,
next steps.

### Structure by Section

| Section         | Structure                                        |
| --------------- | ------------------------------------------------ |
| Start           | E, except Quickstart which uses B                |
| Getting Started | B (D for Project Anatomy)                        |
| Concepts        | A, or D for architectural pages                  |
| Guides          | B                                                |
| Reference       | C                                                |
| Examples        | A                                                |
| Community       | B                                                |

## Astro Reference

Full documentation: https://docs.astro.build

Consult these guides before working on related tasks:

- [Adding pages, dynamic routes, or middleware](https://docs.astro.build/en/guides/routing/)
- [Working with Astro components](https://docs.astro.build/en/basics/astro-components/)
- [Using React, Vue, Svelte, or other framework components](https://docs.astro.build/en/guides/framework-components/)
- [Adding or managing content](https://docs.astro.build/en/guides/content-collections/)
- [Adding styles or using Tailwind](https://docs.astro.build/en/guides/styling/)
- [Supporting multiple languages](https://docs.astro.build/en/guides/internationalization/)
