---
title: Framework brand research
description: How nine frameworks tie their logo, name and visual style to their concept — input for Routa's brand.
---

Research date: 2026-11-12. Sources are first-party: official sites, site source repos, and creator statements. A claim with no first-party source is labeled **observation** (what I saw myself) or **unverified**. Fonts come from each site's CSS, `@font-face` rules, and package manifests.

---

## Hono

**Concept → design**

- Name: Hono "means flame🔥 in Japanese" ([hono.dev/docs](https://hono.dev/docs/)).
- Logo: an orange flame (observation, from `hono.dev/images/logo-large.png`). The mark draws the name itself. I found no first-party statement that connects the flame to speed. Calling the flame a metaphor for speed is an inference.
- Variant: the site has a "kawaii" logo toggle. Its alt text reads: the first "o" is replaced with a flame, with Japanese characters and "a JSX fragment closing tag above the flame" ([HeroImage.vue](https://github.com/honojs/website/blob/main/.vitepress/theme/components/HeroImage.vue)).
- Mascot: none.

**Style**

- Colors: orange brand ramp `#e36002` to `#ff9c24` on a neutral gray base ([custom.css](https://github.com/honojs/website/blob/main/.vitepress/theme/custom.css)).
- Type: Inter, served as `inter-roman-latin.woff2` from hono.dev, with the VitePress default mono stack.
- Landing: code-first. The hero reads "Hono / Web application framework" with Get Started and GitHub buttons. A fake editor window beside it shows the five-line `new Hono()` hello world ([index.md](https://github.com/honojs/website/blob/main/index.md), [HeroImage.vue](https://github.com/honojs/website/blob/main/.vitepress/theme/components/HeroImage.vue)). Four emoji feature cards follow.
- Docs: stock VitePress with light theming ([package.json](https://github.com/honojs/website/blob/main/package.json)). Landing and docs share one system: both are VitePress pages.

**Memorable**: The name, the logo, and the emoji are the same flame. Then the site shows code immediately.

---

## Fastify

**Concept → design**

- Name: unverified. No first-party source explains it. The obvious reading is "fast" + "-ify" (observation).
- Logo: a black, angular big-cat head (cheetah-like) with horizontal speed bars trailing behind it (observation, from [fastify/graphics short-logo.png](https://github.com/fastify/graphics)). "Logo and identity designed by Cosmic Fox" ([fastify/graphics README](https://github.com/fastify/graphics)). I found no first-party statement of what the animal means.
- Mascot: none beyond the logo animal.

**Style**

- Colors: dark-first. `theme-color` is `#0a0b0d` (fastify.dev HTML). The logo is monochrome.
- Type: Space Grotesk (display), Inter (body), JetBrains Mono (code), all loaded via `@fontsource-variable` ([package.json](https://github.com/fastify/website/blob/main/package.json)).
- Landing: pitch-first. The hero is "A fast, low-overhead web framework for Node.js" with a version badge, an install command, a stats strip, and a throughput chart. "Efficiency is a feature" and six strength cards come next. The first code sample (TypeBox) only appears mid-page ([fastify.dev](https://fastify.dev/)).
- Docs: a custom Astro + Tailwind site with Pagefind search ([fastify/website](https://github.com/fastify/website)). Landing and docs share one system.

**Memorable**: Everything says speed: the animal, the speed bars, the benchmark chart in the hero, and the closing line "Ready to go fast?".

---

## NestJS

**Concept → design**

- Name: unverified. No first-party explanation found.
- Logo: a red, stylized cat head (observation, from nestjs.com/img/logo-small.svg). Asked whether the cat has a story, creator Kamil Myśliwiec answered "None!" and attributed it to his love of cats. As an after-the-fact fit, he added that cats are "independent creatures, individualists, very proud animals," which matches Nest's vision ([angular.love interview](https://angular.love/en/interview-with-kamil-mysliwiec-part-1)).
- Mascot: the logo cat. The creator says it is not tied to the concept.

**Style**

- Colors: red (`#ea2845` / `#ed2945` in the site CSS) on near-black. The docs `theme-color` is `#0c0a0b`.
- Type: the landing uses Manrope and Geist Mono (Google Fonts requests on nestjs.com). The docs use Manrope and Inconsolata (gstatic requests on docs.nestjs.com).
- Landing: pitch-first. A headline and subhead claim "fastest-growing Node framework", followed by a client-logo strip, six feature cards (Modules, DI, Decorators…), paid tools, enterprise support, and courses. The CLI install command sits near the bottom ([nestjs.com](https://nestjs.com/)).
- Docs: a custom Angular app ([nestjs/docs.nestjs.com](https://github.com/nestjs/docs.nestjs.com)). Landing and docs are separate sites. They share the red and Manrope but use different mono faces.

**Memorable**: A bold red cat on black. The logo carries the brand, and it says nothing about the framework.

---

## Elysia

**Concept → design**

- Name: unverified. No first-party source explains it. The creator's posts reference _Honkai Impact 3rd_, which has a character named Elysia, but none of them say the framework is named after her ([Elysia 1.0 post](https://elysiajs.com/blog/elysia-10)).
- Logo: a gray and white fox curled into a circle (observation, from `docs/public/assets/elysia.svg` in [elysiajs/documentation](https://github.com/elysiajs/documentation)). The site's header alt text describes a curved "Elysia JS" text logo.
- Mascot: "Elysia chan", an arctic fox girl. SaltyAom writes a monthly four-panel comic about her. The site says technology should be "cute and fun" rather than serious ([elysiajs.com/illust](https://elysiajs.com/illust), [elysiajs.com/4koma](https://elysiajs.com/4koma)). The mascot appears on the landing's first screen.

**Style**

- Colors: pink brand (`--vp-c-brand-1: #f06292`) plus Tailwind gradient text (sky→teal, fuchsia→orange) ([tailwind.css](https://github.com/elysiajs/documentation/blob/main/docs/tailwind.css), [layout.vue](https://github.com/elysiajs/documentation/blob/main/docs/.vitepress/theme/layout.vue)).
- Type: a system/Inter sans stack with self-hosted Geist Mono for code ([tailwind.css](https://github.com/elysiajs/documentation/blob/main/docs/tailwind.css)). It imports `vitepress/theme-without-fonts`.
- Landing: the slogan comes first. "Ergonomic Framework for Humans" is followed by the `bun create elysia app` command, the mascot, and a "Trusted by" row. Code arrives in the second section ("Design for Humans"). Then come "Single Source of Truth" sections: schemas drive validation, types, the client, and OpenAPI ([elysiajs.com](https://elysiajs.com/)).
- Docs: VitePress, heavily customized with Tailwind, Monaco, and an interactive tutorial ([package.json](https://github.com/elysiajs/documentation/blob/main/package.json)). Landing and docs share one system.

**Memorable**: An anime mascot and a pink gradient in backend tooling. Nothing else in this category looks like it.

---

## tRPC

**Concept → design**

- Name: "tRPC (TypeScript Remote Procedure Call)". RPC is "a way of calling functions on one computer (the server) from another computer (the client)" ([trpc.io/docs/concepts](https://trpc.io/docs/concepts)).
- Logo: three white isometric cubes joined by lines on a blue `#398CCB` rounded square ([www/public/logo.svg](https://github.com/trpc/trpc/blob/main/www/public/logo.svg)). It reads as connected nodes or procedures (observation). I found no first-party explanation.
- Mascot: none.

**Style**

- Colors: blue `#398CCB` app-icon tile. The site follows the system light/dark preference (inline theme script on trpc.io).
- Type: Inter via `@fontsource/inter` ([www/package.json](https://github.com/trpc/trpc/blob/main/www/package.json)), with Shiki/Twoslash for code.
- Landing: the headline comes first. "Move Fast and Break Nothing. End-to-end typesafe APIs made easy." is followed by "As used by", then a "How it works" section, Features, and Sponsors (trpc.io HTML headings).
- Docs: a custom site built on TanStack Start + Tailwind, with Twoslash hovers ([www/package.json](https://github.com/trpc/trpc/blob/main/www/package.json)). Landing and docs share one system.

**Memorable**: The headline promises typed safety on the wire, and the docs prove it with real type hovers in the code blocks.

---

## Zod

**Concept → design**

- Name: unverified. Neither the docs nor the README explains it. The common guess, General Zod, is not confirmed by any first-party source.
- Logo: a black, gem- or shield-shaped outline around a "Z" filled with a pale-blue gradient ([logo.svg](https://github.com/colinhacks/zod/blob/main/logo.svg)). A shield fits "validation" (observation). No first-party source states that intent. The site also ships a `logo-glow.png` variant.
- Mascot: none.

**Style**

- Colors: near-monochrome UI. Blue appears only in the logo gradient (observation).
- Type: Inter via `next/font` (class `inter_…` on `<html>`), with a system mono stack.
- Landing: there isn't one. zod.dev opens on the docs Intro page: title, the tagline "TypeScript-first schema validation with static type inference", badges, then a short code example ([zod.dev](https://zod.dev/)).
- Docs: Fumadocs on Next.js ([packages/docs/package.json](https://github.com/colinhacks/zod/blob/main/packages/docs/package.json)). Landing and docs are the same page.

**Memorable**: Three letters, one mark, and a docs page as the front door. The brand relies on ubiquity, not presentation.

---

## TanStack

**Concept → design**

- Name: per Tanner Linsley in a podcast interview, a friend jokingly called his set of libraries "the TanStack". The name stuck as something that "wasn't his name" but could be branded, with a nod to Jamstack ([PodRocket episode](https://podrocket.logrocket.com/tanstack-tanstack-start-and-whats-coming-next-with-tanner-linsley)). I found this through a search summary and did not check the transcript, so treat it as unverified.
- Logo: a 3D palm tree and beach chair on a small island at sunset, inside a black ring (observation, from `public/images/logos/logo-color-600.png`). Linsley: "The palm tree, the island, the relaxed vibe… for me it has always been the easiest visual way to say 'you're in good hands, go enjoy your life'" ([TanStack has a new look](https://tanstack.com/blog/tanstack-has-a-new-look), 2026-07-29).
- Design system: lead designer Andy Beutler built "a new logo system, global type, design tokens, /ds, a component kit, Phosphor icons" (same post).

**Style**

- Colors: primitive ramps plus semantic tokens (same post). The logo is a warm sunset gradient.
- Type: Bricolage Grotesque (display), Inter (body), IBM Plex Mono (code), plus Chopen-SemiBold for library names ([src/styles/app.css](https://github.com/TanStack/tanstack.com/blob/main/src/styles/app.css)).
- Landing: an ecosystem hub. The hero is "The open source application stack for the web", followed by library navigation (Query, Router, Start, Table, Form…), blog, community, and merch.
- Docs: custom, built on TanStack Start and deployed as a Cloudflare Worker ([TanStack/tanstack.com](https://github.com/TanStack/tanstack.com)). One site and one system across every library.

**Memorable**: A vacation island as the logo of a serious data-fetching stack. It sells calm, not mechanism.

---

## Next.js

**Concept → design**

- Name: unverified. No first-party explanation found.
- Logo: a white "N" in a black circle. The diagonal stroke fades to transparent (observation, from the [Vercel-hosted icon](https://assets.vercel.com/image/upload/v1662130559/nextjs/Icon_dark_background.png)). No first-party explanation found.
- Mascot: none.

**Style**

- Colors: black and white. The brand inherits Vercel's monochrome palette (observation).
- Type: Geist and Geist Mono (`--font-geist-sans` and `Geist_Variable` woff2 on nextjs.org). Geist is "Vercel's typeface for developers and designers… inspired by Swiss design" ([vercel.com/font](https://vercel.com/font)).
- Landing: pitch-first. The H1 is "The React Framework for the Web", followed by "Everything you need to build great products on the web", tooling, customer proof, "Get started in seconds", and "Ready to deploy?" (nextjs.org HTML headings).
- Docs: custom, on the same nextjs.org site. Landing and docs share one system.

**Memorable**: A strict monochrome and a house typeface. The brand is the parent company's design language, applied to a framework.

---

## Astro

**Concept → design**

- Name: unverified. The space theme runs through the brand: the mascot is named Houston, and there's the Astro Mart merch store (observation).
- Logo: refreshed in 2023 with "minor refinements, such as adjusting the shape of the mark". The previous mark "was visually difficult to center" ([Welcome, World](https://astro.build/blog/welcome-world/)). No first-party statement says what the mark depicts. The logomark is reserved "for very small representations of Astro" ([astro.build/press](https://astro.build/press/)).
- Mascot: Houston, "our friendly Astro mascot… whimsical, approachable, and friendly". "He may seem a bit square, but his visual simplicity is his strength". He started as a "blob" in the `npm create astro` CLI ([Welcome, World](https://astro.build/blog/welcome-world/)). Houston "must not be used in your own materials" ([press](https://astro.build/press/)).
- Agency: Streiloff & Co ([Welcome, World](https://astro.build/blog/welcome-world/)).

**Style**

- Colors: dark-first. `<html>` carries `[color-scheme:dark] bg-astro-dark-900`, and `theme-color` is `#8D46E7` (astro.build HTML). The rebrand paired dark mode "with a unique color palette and original illustration style" (Welcome, World).
- Type: Obviously (OH no Type Co.) as the main face, MDIO (Mass-Driver) for code (Welcome, World), and Inter for body text (astro.build `@font-face`).
- Landing: pitch-first with an install command. The hero is "The web framework for content-driven websites", with Get Started and `npm create astro@latest`, then logos and concept sections (Server-First, Content-Driven, Islands…).
- Docs: Starlight, Astro's own docs theme (`generator` meta: Starlight v0.42.7 on docs.astro.build). Landing and docs are split: a custom expressive marketing site and a stock-ish docs theme.

**Memorable**: Loud, wide display type on dark purple, a square mascot, and a docs theme the team ships as a product.

---

## Synthesis

### Patterns

|          | Mark type               | Mark tied to name/concept?              | Mascot            | Theme       | Docs                    | Landing = docs system? |
| -------- | ----------------------- | --------------------------------------- | ----------------- | ----------- | ----------------------- | ---------------------- |
| Hono     | Pictorial (flame)       | Literal to **name**                     | No                | Toggle      | VitePress               | Yes                    |
| Fastify  | Animal + speed bars     | "Fast", observation only                | No                | Dark        | Custom (Astro)          | Yes                    |
| NestJS   | Animal (cat)            | No, creator says "None!"                | Logo cat          | Dark        | Custom (Angular)        | No (two sites)         |
| Elysia   | Animal (fox)            | To mascot, not concept                  | Yes (Elysia chan) | Toggle      | VitePress (heavy)       | Yes                    |
| tRPC     | Abstract (linked cubes) | Plausibly "connected calls", unverified | No                | Toggle      | Custom (TanStack Start) | Yes                    |
| Zod      | Lettermark in shield    | Shield ≈ validation, unverified         | No                | Toggle      | Fumadocs                | Docs is landing        |
| TanStack | Illustration (island)   | Emotional ("good hands"), stated        | Island scene      | Toggle      | Custom                  | Yes                    |
| Next.js  | Lettermark (N)          | No                                      | No                | Not checked | Custom                  | Yes                    |
| Astro    | Lettermark/abstract     | Space theme, observation                | Yes (Houston)     | Dark        | Starlight               | No                     |

- **Mark types**: 3 animals (Fastify, NestJS, Elysia), 2 lettermarks (Zod, Next.js), plus Astro's abstract A-like mark. Hono is one pictorial symbol, tRPC one abstract diagram, TanStack one scene illustration. None uses a pure wordmark as its primary mark.
- **Literal ties**: only Hono's mark is first-party tied to its name (flame = hono). None of the nine has a first-party statement tying its mark to its **technical mechanism**. tRPC's linked cubes come closest, and that reading is unverified.
- **Stated meaning is rare**: only TanStack (calm), Astro (Houston as welcoming), and NestJS ("no story") have creator statements about the imagery.
- **Mascots**: Elysia and Astro have true characters. Both are used for warmth and fun, not to explain the product.
- **Dark-first**: Fastify, Astro, and NestJS. The rest follow system preference or a toggle.
- **Docs**: 4 off-the-shelf (Hono and Elysia on VitePress, Zod on Fumadocs, Astro on Starlight) and 5 custom. Seven of the nine keep landing and docs in one visual system. Only NestJS and Astro split them.
- **Type**: Inter is the default body face (Hono, Fastify, tRPC, Zod, TanStack, Astro). Character comes from a display face (Space Grotesk, Bricolage Grotesque, Obviously, Manrope) or a house face (Geist).
- **Code on the first screen**: Hono (editor window), Zod (docs intro), and arguably Elysia (install command, then code). Fastify, NestJS, Next.js, and Astro lead with a pitch.

### What fits Routa

Routa's concept is concrete and visible in code: a file path becomes a URL, a Zod contract becomes types plus OpenAPI, and `routa check` proves they agree. Most of these brands had nothing comparable to draw and fell back on speed, animals, or mood. Routa can show its mechanism.

- **File tree as the API: strong fit.** Only Routa makes `routes/users/$userId/route.ts → /users/:userId` the product. Like Hono's editor-window hero, but with a tree on the left and an HTTP method + path on the right. None of the nine owns this image.
- **Contract/schema as visual: strong fit, with a risk.** It matches Elysia's "Single Source of Truth" story, which Elysia tells in sections rather than in its brand. The risk: a schema block is code, and code alone reads as Zod's or tRPC's territory. Pair it with the route path so the image says HTTP.
- **Proof/verified: good as a supporting motif, weak as the mark.** Zod's shield shows the trap: a generic "safe" symbol fits any validation tool. Use `routa check` output (diagnostic codes, a pass line) as hero evidence, not as the logo.
- **Request→response: fits the concept but is generic.** Arrows and envelopes describe every HTTP framework, so Fastify or Hono could claim it equally. Use it only if the drawing names typed input and named outcomes, not just "in → out".
- **Signal switching: risky.** It is visually close to routing, but it pulls toward networking and transit, which the name is explicitly not about. Like Fastify's speed bars, it would sell a property, not the contract.
- **Pure typography: safe, low-memory.** Next.js and Zod show it works when the product is already famous or the parent brand carries it. At v0, Routa has neither. Typography should be the base layer (one display face, Inter-class body, a good mono) under one of the concrete directions above.
- **Mascot or animal: poor fit.** Elysia and Astro use mascots for warmth. NestJS's cat has, by its creator's account, no meaning. AGENTS.md asks for "the source explains itself" and no hidden conventions, and an unrelated character works against that.
- **Practical takeaways**: keep landing and docs in one system (seven of nine do). Put real code on the first screen (Hono, Zod). Prefer a mark you can draw from the product's own artifacts (path segment, `$param`, contract block) over an emotional metaphor.
