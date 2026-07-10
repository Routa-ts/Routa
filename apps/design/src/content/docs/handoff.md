---
title: Landing handoff
description: Competitive research and brief for five new Lattice landings — clean start.
---

**Focus for next session:** Create **five new** Lattice-branded marketing landing options for Routa in `apps/design`, informed by competitive research. Do **not** revive deleted landing compositions.

**Suggested skills:** None required. Optional: visual QA via browser tools after build.

---

## Product (Routa)

- Schema-first, OpenAPI-aware REST framework for **new TypeScript APIs**
- Filesystem routes · Zod contracts · Hono runtime · typed middleware
- CLI: check / build / start · bidirectional OpenAPI (scaffold + emit)
- Public site: `apps/docs` — marketing at `/`, Starlight docs at `/docs/`
- Design lab: `apps/design` (port **4322**) — review-only; not `routa-ts.dev`
- Brand locked: **Lattice** (see tokens below)
- Maturity: **v0** — be honest; no fake enterprise logo walls

---

## Lattice design system (use this)

| Token | Value / role |
| --- | --- |
| Accent / edge | `#0d9488` (teal) |
| Node / highlight | `#5eead4` |
| Background | `#0f1115` graphite |
| Elevated | `#15181e` |
| Text | `#eceff4` |
| Muted | `#8b93a4` |
| Lines | `#2a303c` |
| Sans | Space Grotesk |
| Mono | Space Mono |
| Mark | `apps/design/public/favicon.svg` (compass/star) |

Docs already apply Lattice via `@theme` in `apps/docs/src/styles/global.css`. Landings should feel like the same system, not a fifth identity.

**Voice:** Precise, schema-literate, slightly austere — Hono/Express clarity + TanStack honesty. Category-defining, not hype. No Fortune-500 theater.

---

## Competitive research (Jul 2026)

Sites studied: **Astro**, **Next.js**, **NestJS**, **Nuxt**, **Hono**, **Express**, **TanStack Start**.

### A. Patterns that repeat (table stakes)

| Pattern | What almost everyone does |
| --- | --- |
| Hero anatomy | Brand as primary signal → one category H1 → one supporting line → 1–2 CTAs |
| Primary CTA | Get Started / docs; often + copyable CLI (`create` / `npx`) |
| Secondary CTA | Learn / GitHub / video / “copy prompt” (newer) |
| Code in first fold | Hello World, playground tabs, or snippet proving DX in seconds |
| Proof strip | Logos, quote, stats, or showcase — even if thin |
| Pillars | 3–6 feature cards tied to real primitives |
| Foundation | “Built on X” (React/Vue/Vite/Web Standards/…) |
| Docs path | Same-domain docs or obvious exit to docs |
| Visual system | Strong brand color + distinctive type; coherent dark *or* austere |

### B. What makes each unique

- **Astro** — Content-driven category claim + CWV bake-off; islands/framework tabs as demo
- **Next.js** — “The React Framework” ownership + Vercel deploy/templates funnel; Geist B/W
- **NestJS** — Enterprise aurora theater + editable Bootstrap/Controller/Module tabs; cat mythology; courses/products
- **Nuxt** — Full-stack Vue + hero DX playground; Evan You quote; modules marketplace
- **Hono** — Name-as-hero + 6-line Web Standards Hello World; radical sparsity (4 cards, almost no proof)
- **Express** — Slogan-as-H1 + WebGL atmosphere; docs shell *is* marketing chrome; austere classic
- **TanStack Start** — Router-first + numbered request trace; RC honesty; agent-era “Copy Prompt” CTA

### C. Implications for Routa

**Adopt**
- Category H1 that names the job (schema-first / contract-routed REST) — not “another Node framework”
- Dual CTA: Get Started + copyable CLI
- Code-first proof in hero: route file → contract → handler → OpenAPI in one glance
- Short pillar grid (≤6) on real primitives: filesystem routes, Zod, OpenAPI bidirectional, typed middleware, CLI lifecycle, Hono
- “Built on Hono + Zod + OpenAPI + TypeScript”
- Honest v0 / RC-style candor

**Avoid**
- React/Vue fullstack framing, islands, SSR app showcases, “deploy to our cloud”
- Fake enterprise logo walls / partner theater
- Product-suite upsells (courses, marketplaces) before the core story
- Generic “fast, modern, delightful DX” interchangeable with any framework
- Default AI-landing looks (purple glow, cream+serif terracotta, broadsheet)
- Stats-in-hero unless numbers are real

**Content pillars**
1. **Route = contract** — filesystem path is the API surface; Zod owns I/O  
2. **Lattice** — middleware, handlers, schemas compose into a typed graph  
3. **OpenAPI as peer** — generate and consume; spec and code stay in lockstep  
4. **Check before run** — CLI validates before `start`  
5. **Hono underneath** — Web Standards runtime; Routa owns the contract layer  

**Visual directions (leave layouts open)**
- Diagrammatic / cartographic: routes as edges, contracts as nodes, OpenAPI as projection
- Blueprint / schematic / lattice linework — not cosmic neon or SaaS product shots
- Code + structural diagram as co-equal heroes
- Restrained motion: path draw, contract snap, check pass — presence, not Nest theater
- Engineered type (mono + distinctive display)

### D. Content inventory (for new landings)

**Headline themes**
- Schema-first REST for TypeScript
- Filesystem routes with contracts, not vibes
- OpenAPI that stays true to the code
- The lattice between route, schema, and runtime
- Check the API before you ship it

**Demo metaphors**
- Single route file → Zod → handler → emitted OpenAPI path
- Request walks the lattice: middleware → validate → handler → response schema
- CLI `check` failing on drift, then passing
- Bidirectional: edit Zod *or* OpenAPI, regenerate the other
- Side-by-side: untyped handler vs contracted route

**Proof realistic for v0 OSS**
- Copyable CLI + short Hello Contract
- GitHub / npm only if numbers help; else omit
- “Built on Hono + Zod” tech badges (not company logos)
- OpenAPI snippet from in-repo example
- Explicit v0 scope callout
- Named human quotes if available — never fake logos
- Optional agent CTA: “Copy scaffold prompt”

**Section blocks to mix**
- Hero (brand + H1 + one line + CLI + code)
- How it fits together (3-step)
- Primitives grid
- OpenAPI bidirectional
- CLI lifecycle (`check` → `build` → `start`)
- Honest v0 scope
- Close: docs / GitHub

---

## Task for next agent

1. Create **five distinct** landing compositions under `apps/design` (e.g. `src/pages/landings/…`).
2. Each must use **Lattice** tokens and Routa’s router/contract story — different *composition and metaphor*, not five skins of one layout.
3. Add a small hub at `/landings/` listing all five for review.
4. Wire sidebar links in `apps/design/astro.config.mjs`.
5. Do **not** copy deleted landings; do **not** ship a winner to `apps/docs` until the user picks one.
6. Keep production `apps/docs` `/` as a minimal stub (or leave untouched) until a landing is chosen.
7. `pnpm --filter @routa-ts/design build` must pass.

### Commands

```sh
pnpm --filter @routa-ts/design dev    # :4322
pnpm --filter @routa-ts/docs dev      # :4321 — / and /docs/
```

### Hard constraints (from project design rules)

- First viewport = one composition; brand is hero-level
- No card-heavy hero; cards only when they aid interaction
- Full-bleed / atmospheric OK; avoid inset media cards and floating promo chips
- Ship 2–3 intentional motions per visually led landing
- Mobile + desktop

---

## Out of scope / deleted

Previous design-lab landing experiments were removed after this handoff. Do not reconstruct them from memory. Start from research + Lattice only.
