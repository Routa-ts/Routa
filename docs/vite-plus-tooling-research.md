# Vite+ for Routa framework development

Research checked on 2026-10-21 against official guides, the published Vite Plus 1.3.0 artifact, tagged source, and this checkout. This note evaluates repository development tooling. It does not approve a migration, change Routa's HTTP contract, or change the dependencies, scripts, defaults, or templates generated for application developers. It covers every documented product family and the upstream features useful to Routa, rather than every CLI flag.

This is the research snapshot before implementation. See the [tested migration results](vite-plus-migration-results.html) for the final choices and compatibility evidence. Repository observations below describe the baseline commit, not the migrated branch.

## Recommendation

Adopt Vite+ in stages if its checks pass against this repository. Start with Oxlint, Oxfmt, and the existing Vitest tests. Keep pnpm and Routa's verification commands. Move task orchestration next, then consider replacing the package build implementation after comparing published artifacts and consumer checks. This is a proposed adoption plan, not verified compatibility with Routa.

Vite+ can consolidate development tools without making Vite a Routa runtime dependency. Its local `vite-plus` package contains the toolchain and can run through `pnpm exec vp`; contributors do not need to install the global CLI. The global CLI adds environment management, which is optional for this migration. [Project-local CLI](https://viteplus.dev/guide/local-cli)

## Verified upstream facts

### Available tools and license

Vite+ combines Vite, Vitest, Oxlint, Oxfmt, Rolldown, tsdown, and its task runner. The registry's latest release resolved to 1.3.0 during this research, with MIT licensing. Its published toolchain manifest reports Vite 8.3.4, Rolldown 1.2.14, Vitest 5.0.5, Oxlint 1.88.0, Oxfmt 0.73.0, oxlint-tsgolint 7.0.2004, tsdown 0.23.1, and Vite Task revision `9ba4cc9`. Check the selected release's manifest before implementation rather than assuming all releases bundle the same tools. [Published package](https://registry.npmjs.org/vite-plus/1.3.0), [published toolchain manifest](https://unpkg.com/vite-plus@1.3.0/dist/toolchain.json), [getting started](https://viteplus.dev/guide)

`vp lint` uses Oxlint, the linter from Oxc. `vp fmt` uses Oxfmt. Oxc is the tool family, rather than the linter's command name. Vite+ keeps their configuration in root `vite.config.ts` `lint` and `fmt` blocks. [Lint](https://viteplus.dev/guide/lint), [Format source documentation](https://github.com/voidzero-dev/vite-plus/blob/main/docs/guide/fmt.md)

### pnpm and monorepos

`vp install` delegates to the project's package manager; it does not replace pnpm's dependency resolver or lockfile format. Detection first uses `packageManager`, followed by `devEngines.packageManager`, workspace configuration, and lockfiles. The docs explicitly demonstrate a pnpm 11 version range. Frozen installs and workspace filters are supported. Existing pnpm workflows can remain while the toolchain changes. [Package management](https://viteplus.dev/guide/package-management)

Monorepos use a root `vite.config.ts` for lint and format settings. Package-specific differences belong in root `lint.overrides` and `fmt.overrides`. Running root checks does not apply nested package configs per file. Separate package configs remain available for tests, packaging, and framework-specific behavior. [Monorepo guide](https://viteplus.dev/guide/monorepo)

### Tests

The current test guide says Vite+ bundles Vitest 5.0.5 and requires Node `^22.18.0 || ^24.11.0 || >=26.0.0`. For Routa contributors using Node 24, that means at least 24.11.0, without implying a new Node engine requirement for published Routa packages. `vp test` runs once by default; `vp test watch` enables watching. Test APIs are available through `vite-plus/test`, and test configuration goes under `test` in `vite.config.ts`. [Test](https://viteplus.dev/guide/test)

Ordinary `vitest` imports migrate to `vite-plus/test`. Upstream module augmentations and references such as `compilerOptions.types`, `require.resolve`, and package metadata reads retain their original identity. They may require a direct package-local Vitest dependency. Keep all Vitest copies aligned with the version shown by `vp toolchain vitest`; the pnpm override documented for this uses `vitest@*`. [Migration rules](https://viteplus.dev/guide/migrate-rules), [Update Vite+](https://viteplus.dev/guide/upgrade-project)

Routa already uses Vitest, so this is runner consolidation rather than a migration from `node:test`. No upstream evidence reviewed here establishes automatic conversion of arbitrary Node test suites. Existing native HTTP, subprocess, exit-code, timing, or filesystem checks should keep their assertions and execution semantics.

### Static checks and Biome

`vp check` combines formatting, linting, and optional type checking. `lint.options.typeAware` enables type-aware rules; `typeCheck` enables type checking through the TypeScript Go and tsgolint path. Both must be enabled for the combined type-check path. [Check](https://viteplus.dev/guide/check)

Oxlint explicitly documents `oxlint --type-aware --type-check` as a replacement for a separate `tsc --noEmit` CI step. Type-aware linting alone runs semantic lint rules; adding type checking also reports TypeScript compiler errors. Standalone Oxlint requires `oxlint-tsgolint`. For Routa, replacing development `tsc --noEmit` commands is a migration goal once equivalent project and test-file coverage is demonstrated. This does not replace declaration emission, the CLI's compiler API, Astro checks, or Routa contract validation. [Oxlint type-aware linting](https://oxc.rs/docs/guide/usage/linter/type-aware.html)

Stability differs between these capabilities. Type-aware linting has a stable release, while Oxlint's CLI still describes the compiler-diagnostic `--type-check` flag as experimental. That is a reason to compare diagnostics and coverage before removing the existing compiler step. [Type-aware stable release](https://oxc.rs/blog/2026-07-22-type-aware-linting-stable.html), [CLI reference](https://oxc.rs/docs/guide/usage/linter/cli)

This can replace Biome's development lint and format commands, but equivalent rule coverage and formatting are a migration task. The documented Vite+ automated migration targets ESLint, Prettier, Oxlint, Oxfmt, and other listed tools; it does not promise a complete Biome lint-rule conversion. Oxfmt separately offers `--migrate=biome` for formatter configuration. Review the result and move the relevant settings into Vite+'s `fmt` block. [Migration guide](https://viteplus.dev/guide/migrate), [Oxfmt CLI](https://oxc.rs/docs/guide/usage/formatter/cli.html)

Oxfmt supports TypeScript, JSON, CSS, YAML, Markdown, and other formats. Its Astro formatting requires `@astrojs/compiler-rs` and the `astro` option. MDX and Astro currently use bundled Prettier-backed formatting. These are formatting capabilities, not replacements for Astro's compiler or framework checks. [Oxfmt language support](https://oxc.rs/docs/guide/usage/formatter/language-support)

Oxlint's type-aware path does not support TypeScript `baseUrl`; migration attempts a tsconfig conversion before enabling it. Verify Routa's actual tsconfigs rather than assuming `vp check` reproduces every current project-level type check. [Troubleshooting](https://viteplus.dev/guide/troubleshooting)

### Task orchestration

`vp run` executes existing package scripts and configured tasks with dependency ordering, workspace support, and caching. Package scripts are uncached by default; task configuration can enable or disable caching. These capabilities make it a candidate to replace Turbo after translating the repository's dependency order and outputs. [Run](https://viteplus.dev/guide/run)

Built-in commands do not dispatch package scripts. For example, `vp build` runs Vite's build command, while `vp run build` executes the repository's build script. An Astro `dev` script similarly needs `vp run dev`. Preserve this distinction when replacing orchestration commands. [Run](https://viteplus.dev/guide/run)

### Library and CLI builds

`vp pack` uses tsdown for publishable libraries and CLI artifacts. It supports declarations, multiple output formats, source maps, and minification, configured under `pack` in `vite.config.ts`. `vp build` is for Vite web applications. Native executable output is a separate experimental option and is unnecessary for retaining Routa's ordinary Node CLI distribution. [Pack](https://viteplus.dev/guide/pack)

tsdown generates declarations through `rolldown-plugin-dts`. Its declaration generator can be `tsc`, `tsgo`, or `oxc`. The documented selection uses `oxc` with `isolatedDeclarations`, `tsgo` for TypeScript 7, and `tsc` otherwise. Oxc declaration generation requires code compatible with `isolatedDeclarations`. Do not add that restriction merely to obtain faster builds in an inference-heavy framework. [Declaration options](https://tsdown.dev/reference/api/Interface.DtsOptions), [Declaration guide](https://tsdown.dev/options/dts)

Replacing esbuild or TypeScript emission is plausible, but Routa compatibility remains unverified. Preserve package export paths, `.js` and declaration layout, ESM behavior, CLI entrypoints, shebangs, copied files, external runtime dependencies, and consumer type behavior. The CLI's direct TypeScript dependency and `typescript/unstable/*` imports serve framework analysis and must remain unless a separate implementation change replaces that functionality.

### CI

The official `voidzero-dev/setup-vp` GitHub Action can install Vite+, Node, the selected package manager, and dependencies. It also supports package-manager caching. The docs require an exact release or commit SHA and say the `v1` tag no longer receives updates. Task-result caching needs separate configuration. Using this action is optional when existing CI can invoke the pinned local CLI through pnpm. [CI](https://viteplus.dev/guide/ci), [Project-local CLI](https://viteplus.dev/guide/local-cli)

## Migration boundaries for Routa

`vp migrate` is the existing-project command. It must target the monorepo root, because manifests, package-manager settings, catalogs, and lockfiles are shared. It rewrites supported imports and scripts, merges configuration, and can set up hooks, agent files, and editor files. The guide warns that most projects still need manual adjustments. It recommends Vite 7+ and Vitest 4+ for existing installations. [Migration guide](https://viteplus.dev/guide/migrate)

After migration, formatting covers files changed by migration and excludes paths already dirty in Git. Non-Git projects retain full-project formatting. Import rewriting and dependency changes still span the workspace, so the command is broader than the requested framework-only boundary. [Migration rules](https://viteplus.dev/guide/migrate-rules)

For this repository, prefer a manual migration or inspect the automated result in a disposable checkout. Neither approach should alter scaffold payloads merely because a framework test imports Vitest. Preserve generated-project dependencies and scripts, template text, their expected snapshots, and formatter config fixtures. Root lint and format ignores or overrides must protect these intentional consumer defaults. This follows the user's scope and keeps integration scaffolds application-owned under [ADR-0015](adr/0015-application-owned-integration-scaffolds.md).

The first implementation should keep the existing `pnpm verify` entrypoint and its framework-specific checks. In particular, a generic static check does not replace route graph validation, deterministic generated-state checks, OpenAPI checks, packed-package verification, or example consumer checks. [AGENTS.md](../AGENTS.md) and [ADR-0003](adr/0003-commit-generated-routa-state.md) require those guarantees to remain coherent.

## Proposed implementation order

1. Add a pinned local Vite+ development dependency and the documented pnpm overrides. Keep pnpm's existing version policy. Configure root lint, format, and test behavior, with explicit scope for fixtures, generated state, and scaffolds.
2. Translate Biome rules, suppressions, ignores, formatting, and import sorting deliberately. Run existing tests with Vite+'s bundled Vitest. Keep direct Vitest only where upstream identity references require it.
3. Replace Turbo orchestration once task ordering and output handling are equivalent. Keep commands that inspect or mutate generated contract state or package artifacts uncached unless their complete inputs and outputs are established.
4. Prototype `vp pack` for one package and compare its packed files, exports, runtime behavior, and consumer declarations with the current build. Replace the existing build only after those checks pass for each publishable package.
5. Update contributor instructions and CI commands. Run `pnpm verify` and confirm scaffold output retains the current consumer defaults.

No tooling packages were installed and no compatibility tests were run for this research note. A performance claim needs a repository baseline and the same checks after migration; upstream benchmark ratios are not evidence of Routa's expected speedup.

## Full feature inventory for Routa

The priorities below are recommendations, not executed compatibility results. "Use first" means include it in a bounded initial migration. "Pilot" means prove equivalent behavior before replacing the current tool. "Optional" means adopt only if it solves an observed problem. Vitest's existing features are available through Vite Plus, rather than new capabilities invented by it.

### Static checks and formatting

| Feature                                              | Priority  | How we can use it                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Combined format, lint, and type check                | Use first | Make `vp check` the framework static-check entry point after coverage is proven. Keep `pnpm verify` as the aggregate. [Check](https://viteplus.dev/guide/check)                                                                                                                                                      |
| Syntax linting and reviewed fixes                    | Use first | Replace framework Biome lint commands with `vp lint`; map explicit rules, suppressions, and test exceptions before choosing a preset. [Lint](https://viteplus.dev/guide/lint)                                                                                                                                        |
| Type-aware lint rules                                | Use first | Enable useful semantic rules, including unhandled and misused promises, for asynchronous request execution, cleanup, and CLI work. Enabling type analysis alone does not mean every rule is enabled. [Oxlint type-aware guide](https://oxc.rs/docs/guide/usage/linter/type-aware.html)                               |
| Compiler diagnostics during lint                     | Pilot     | Enable `typeAware` and experimental `typeCheck` together, then compare source, test, and expected-failure coverage before removing `tsc --noEmit`. [Type checking](https://oxc.rs/docs/guide/usage/linter/type-aware.html#type-checking-diagnostics), [stability](https://oxc.rs/docs/guide/usage/linter/cli)        |
| Formatting and format verification                   | Use first | Use `vp fmt` and `vp fmt --check`, retaining tabs, double quotes, semicolons, and the intended line width. [Format](https://viteplus.dev/guide/fmt)                                                                                                                                                                  |
| Import and package.json sorting                      | Pilot     | Evaluate Oxfmt's import sorting and package.json sorting to replace Biome organization. Preserve side-effect import order and intentional scaffold text. [Import sorting](https://oxc.rs/docs/guide/usage/formatter/sorting), [package.json sorting](https://oxc.rs/docs/guide/usage/formatter/sorting#package-json) |
| Tailwind class sorting                               | Optional  | Apply Oxfmt's stylesheet-aware sorting to docs/design classes if it improves maintenance. Import and Tailwind sorting are disabled by default; package.json sorting is enabled by default. [Sorting options](https://oxc.rs/docs/guide/usage/formatter/sorting)                                                      |
| Markdown, MDX, CSS, YAML, JSON, and Astro formatting | Optional  | Broaden checks deliberately, rather than reformatting every documentation file as an incidental migration. Astro formatting needs its optional compiler package and setting. [Language support](https://oxc.rs/docs/guide/usage/formatter/language-support)                                                          |
| Shared rules and file-specific overrides             | Use first | Put lint/format policy in root `vite.config.ts`; express package and fixture differences through root overrides. [Monorepos](https://viteplus.dev/guide/monorepo)                                                                                                                                                    |
| JavaScript lint plugins and custom rules             | Optional  | Preserve an important rule unavailable natively using a compatible plugin. Write a custom rule only for a concrete recurring error. [Plugin support](https://viteplus.dev/guide/lint#js-plugins)                                                                                                                     |
| Cross-file import analysis                           | Optional  | Evaluate import-cycle checks across framework modules. This is a linting aid, not Routa's route-graph analysis. [Multi-file analysis](https://oxc.rs/docs/guide/usage/linter/multi-file-analysis)                                                                                                                    |

A minimal illustration of the combined check configuration is below. It is not a complete Routa configuration:

```ts
import { defineConfig } from "vite-plus";

export default defineConfig({
	lint: {
		options: {
			typeAware: true,
			typeCheck: true,
		},
	},
	fmt: {
		useTabs: true,
		printWidth: 100,
		singleQuote: false,
		semi: true,
	},
});
```

With both options enabled, `vp check --no-fmt --no-lint` requests type checking alone. [Check switches](https://viteplus.dev/guide/check)

Our [Biome config](../biome.json) explicitly checks undeclared dependencies, unused imports, focused/skipped tests, Node import conventions, type-only imports, and secrets. A complete migration needs an equivalence list and explanations for gaps. Two recommended presets are not evidence of equivalent coverage.

Useful explicit rule candidates include `vitest/no-focused-tests`, `vitest/no-disabled-tests`, `typescript/consistent-type-imports`, and `unicorn/prefer-node-protocol`. Bundled Oxlint recognizes tests importing `vite-plus/test`. The inspected rule inventory did not establish exact native equivalents for Biome's `noSecrets` and `noUndeclaredDependencies`; preserve or deliberately resolve those gaps. JavaScript-plugin support is alpha and does not provide arbitrary custom parsers or type-aware JavaScript rules. [Rule inventory](https://oxc.rs/docs/guide/usage/linter/rules), [bundled test recognition](https://github.com/oxc-project/oxc/blob/oxlint_v1.88.0/crates/oxc_linter/src/utils/jest.rs), [JS plugin limits](https://oxc.rs/docs/guide/usage/linter/js-plugins)

### Tests and measurements

| Feature                                      | Priority  | How we can use it                                                                                                                                                                                                                                                                    |
| -------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Unit/integration tests, mocks, and snapshots | Use first | Run the existing package suites through `vp test`; keep assertions and real HTTP/subprocess/filesystem behavior. [Vite Plus tests](https://viteplus.dev/guide/test)                                                                                                                  |
| Watch and focused execution                  | Use first | Use `vp test watch` during edits and Vitest file/name filters to narrow feedback. Plain `vp test` runs once. [Filtering](https://vitest.dev/guide/filtering)                                                                                                                         |
| Test projects                                | Optional  | Give core, CLI, and creator explicit projects, or separate fast tests from process-heavy checks. Keep per-package invocation if it remains clearer. [Projects](https://vitest.dev/guide/projects)                                                                                    |
| Coverage                                     | Optional  | Find untested diagnostic, cleanup, serialization, and error branches. Add a coverage provider matching bundled Vitest; establish a baseline before choosing thresholds. [Coverage](https://vitest.dev/guide/coverage)                                                                |
| Type tests                                   | Pilot     | Check route inference, middleware context, named outcomes, and expected compiler failures. Runtime test transpilation does not check TypeScript. [Type testing](https://vitest.dev/guide/testing-types)                                                                              |
| Benchmarks                                   | Optional  | Measure route analysis, dispatch, or serialization on fixed fixtures. CLI cold starts also need process-level measurements. [Benchmarking](https://vitest.dev/guide/benchmarking)                                                                                                    |
| Reports, sharding, and debugging             | Optional  | Improve CI output or split expensive suites when their observed size justifies it. Debug cleanup/timing failures without changing test intent. [Reporters](https://vitest.dev/guide/reporters), [CLI](https://vitest.dev/guide/cli), [debugging](https://vitest.dev/guide/debugging) |
| Test UI and performance diagnosis            | Optional  | Use the optional aligned `@vitest/ui` package in explicit watch mode, or Vitest's diagnostic tools when a suite hangs or slows down. [UI](https://vitest.dev/guide/ui), [CLI](https://vitest.dev/guide/cli)                                                                          |
| Real browser testing                         | Optional  | Potentially test docs UI behavior. Low immediate value for Node framework tests; Playwright needs an optional provider and browser installation. [Browser mode](https://vitest.dev/guide/browser/)                                                                                   |

For concrete optional workflows, `vp test run --coverage` runs an installed coverage provider; Vitest's `test.typecheck.tsconfig` selects the intended test config, and `typecheck.include` must cover existing test assertions rather than only the default `*.test-d.*` files. Benchmarks use `vp test bench`; Vitest 5's benchmark API differs from older imported `bench` examples and remains experimental. [Coverage](https://vitest.dev/guide/coverage), [typecheck configuration](https://vitest.dev/config/typecheck), [Vite Plus v5 guidance](https://viteplus.dev/guide/vitest-v5)

Preserve working-directory assumptions if consolidating package suites into root projects. Vitest projects do not change `process.cwd()` automatically. Watch/related-test selection follows imports; Routa tests that read templates or generated files through `fs` need explicit watch triggers. [Projects](https://vitest.dev/guide/projects), [watching templates](https://vitest.dev/guide/recipes/watch-templates)

### Workspace tasks, caching, and package builds

| Feature                                      | Priority | How we can use it                                                                                                                                                                                                                                     |
| -------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace scripts and package filters        | Pilot    | Replace Turbo invocation with `vp run --filter './packages/*' build` while keeping package build scripts initially. [Run](https://viteplus.dev/guide/run)                                                                                             |
| Explicit dependency graph                    | Pilot    | Reproduce current build-before-typecheck and build-before-test ordering. Include relevant `devDependencies`; the CLI depends on the creator for development. [Task dependencies](https://viteplus.dev/config/run#dependson)                           |
| Parallel execution and concurrency           | Pilot    | Run independent checks concurrently after prerequisites. Avoid parallel mode for dependent builds. [Concurrency](https://viteplus.dev/guide/run#concurrency)                                                                                          |
| Local task-result caching                    | Pilot    | Reuse deterministic builds and restore `dist/**`. Prove second-run hits, edited-input misses, and deleted-output restoration. [Caching](https://viteplus.dev/guide/cache)                                                                             |
| Automatic file tracking                      | Pilot    | Track reads, missing-file probes, directory listings, and writes without enumerating all source inputs. Validate with Routa's compiler API and subprocesses. [Tracking](https://viteplus.dev/guide/automatic-data-tracking)                           |
| Explicit inputs, outputs, and environment    | Pilot    | Use `cache.input`, `output`, `env`, and `untrackedEnv` where inference is incomplete. Generic filesystem tracking cannot infer arbitrary environment reads. [Cache configuration](https://viteplus.dev/config/run)                                    |
| Cache inspection and cleanup                 | Optional | Inspect hits/misses and clear task results during investigation. Cached success is evidence of replay, not evidence that validation reran. [Cache commands](https://viteplus.dev/guide/cache#cache-commands)                                          |
| Cross-run GitHub Actions cache               | Optional | Persist `node_modules/.vite/task-cache` after local correctness is proven. Upstream labels this workflow experimental; measure restore/save costs. [Actions cache](https://viteplus.dev/guide/github-actions-cache)                                   |
| Multiple package entry points                | Pilot    | Use `vp pack` to emit the current core exports and CLI/creator entries. Configure the separately spawned CLI runtime explicitly. [Pack](https://viteplus.dev/guide/pack), [entry points](https://tsdown.dev/options/entry)                            |
| Bundled/unbundled ESM and dependency control | Pilot    | Preserve core module layout, bundled CLI internals, and deliberate runtime externals. [Unbundled output](https://tsdown.dev/options/unbundle), [dependencies](https://tsdown.dev/options/dependencies)                                                |
| Declaration generation                       | Pilot    | Use a TypeScript-backed generator for inference-heavy public contracts. Verify emitted types against installed consumers. [Declarations](https://tsdown.dev/options/dts)                                                                              |
| Watch package builds                         | Optional | Use `vp pack --watch` for framework edits. Keep dependent output consumption and local CLI linking explicit. [Pack watch](https://viteplus.dev/guide/pack)                                                                                            |
| Build size reports                           | Optional | Inspect CLI/creator output size and unexpected dependency bundling; use raw sizes for Node packages and avoid paying for compressed-size reports when irrelevant. [tsdown report options](https://tsdown.dev/reference/api/Interface.ReportOptions)   |
| publint and Are the Types Wrong              | Optional | Add package metadata and declaration-resolution checks through tsdown. These optional integrations require `publint` and/or `@arethetypeswrong/core` and supplement real packed consumer tests. [Package validation](https://tsdown.dev/options/lint) |

Config-defined tasks are cached by default; existing package scripts are not. Start with `cache: false` for generation consistency, scaffold smoke tests, packed installations, versioning, publishing, and the full verification aggregate. Their mutations, external installs, network state, or real process behavior should execute. Compound commands can become independently cached subtasks, so inspect descendant policies too. [Cache defaults](https://viteplus.dev/guide/cache), [compound commands](https://viteplus.dev/guide/run#compound-commands)

A task cannot use the same name in both `package.json` and `run.tasks`; config-defined tasks need their own command. The runner's pre/post script lifecycle defaults to enabled. Environment variables are filtered: fingerprint meaningful values with `cache.env`, and pass non-result-affecting values through `untrackedEnv`. Routa's current Turbo config fingerprints `CI`, so preserve that explicitly if equivalent behavior is intended. The public schema has no Turbo-style persistent/readiness contract; keep watching with Vitest, Astro, Routa, or `vp pack --watch`. [Task configuration](https://viteplus.dev/config/run)

Dependency-download caching and task-result caching are different. `setup-vp` handles the former; persisting task output needs the separate experimental Actions workflow. No reviewed documentation establishes a hosted Turbo-compatible remote-cache service. [CI](https://viteplus.dev/guide/ci), [Actions cache](https://viteplus.dev/guide/github-actions-cache)

### Contributor workflow and infrastructure

| Feature                                             | Priority  | How we can use it                                                                                                                                                                                                                                |
| --------------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| GitHub Actions provisioning                         | Pilot     | `voidzero-dev/setup-vp` can provision Vite Plus, Node, pnpm, and dependencies in our reusable workflow. Keep exact release/SHA pins and OIDC publishing configuration. [CI](https://viteplus.dev/guide/ci)                                       |
| Oxc/Vitest editor integration                       | Use first | Use the root lint/format policy and runner in VS Code, Zed, or JetBrains. Framework settings can differ from generated-project settings. [IDE integration](https://viteplus.dev/guide/ide-integration)                                           |
| Hooks and staged checks                             | Optional  | `vp staged` gives local staged-file feedback; `vp hooks enable/disable/status` manages the dispatcher. It can replace Husky/lint-staged where used; Routa currently has neither. [Commit hooks](https://viteplus.dev/guide/commit-hooks)         |
| Package-manager facade                              | Optional  | Use `vp install --frozen-lockfile`, `add`, `remove`, `update`, `dedupe`, `outdated`, `why`, or `pm ...` while pnpm remains the resolver. [Package management](https://viteplus.dev/guide/package-management)                                     |
| Local and one-off binaries                          | Optional  | Prefer `vp exec` for installed tools and explicit versions with `vp dlx` for one-off execution. Global `vpx` can fall back to downloads. [Binaries](https://viteplus.dev/guide/vpx)                                                              |
| Node/pnpm environment management                    | Optional  | Global `vp env` can pin, provision, switch, and diagnose contributor environments. Contributors can retain their current setup with the project-local CLI. [Environment](https://viteplus.dev/guide/env)                                         |
| Diagnostics and shell completion                    | Optional  | `vp env doctor/current/which` explains selected tools; completion finds task names for global-CLI users. [Environment commands](https://viteplus.dev/guide/env#commands)                                                                         |
| Toolchain inspection and coordinated upgrades       | Use first | Record `vp toolchain --json`; upgrade Vite Plus, Vite aliases, Vitest pins, and ecosystem packages together. [Inspection](https://viteplus.dev/guide/upgrade#show-the-toolchain), [project upgrades](https://viteplus.dev/guide/upgrade-project) |
| Global self-upgrade and rollback                    | Optional  | `vp upgrade` maintains a contributor's global CLI separately from the project toolchain. [Global upgrades](https://viteplus.dev/guide/upgrade)                                                                                                   |
| Docker/devcontainer image                           | Optional  | Use an exact `ghcr.io/voidzero-dev/vite-plus` tag/digest for reproducible development or container CI. It is a build image. [Docker](https://viteplus.dev/guide/docker)                                                                          |
| App/library/monorepo templates and local generators | Optional  | Useful for disposable experiments or a future internal package generator. Keep the public Routa creator and OpenAPI scaffolding. [Create](https://viteplus.dev/guide/create)                                                                     |
| Organization template catalogs                      | Defer     | An optional future distribution convenience. Routa has no current requirement to publish a separate organization catalog. [Organization templates](https://viteplus.dev/guide/create#organization-templates)                                     |
| Agent/editor configuration generation               | Defer     | Inspect proposed setup, but retain Routa's existing authority and conventions. Tool adoption does not require regenerating `AGENTS.md`. [Migration](https://viteplus.dev/guide/migrate)                                                          |

Package management includes inspection/audit, patching, packaging/publishing, and staging commands through the underlying manager. These wrappers do not replace Changesets' coordinated versions, changelogs, or release workflow. Local-only users use `vp pm list` and `vp pm rebuild` where the shortcuts are global-only. [Package-management reference](https://viteplus.dev/guide/package-management)

If global Vite Plus owns Node/pnpm provisioning, choose that policy explicitly. pnpm 11 can also provision them. The environment guide documents `runtimeOnFail: ignore` and `pmOnFail: ignore` to avoid both managers switching tools independently. Do not add those settings while retaining pnpm's current ownership. [Runtime coordination](https://viteplus.dev/guide/env#node-js-selection)

## Concrete Routa constraints and retained tools

The checkout currently uses Node 24.18.0 and pnpm 11.9.0. Root dependencies include Biome 2.5.12, Turbo 2.11.8, Vitest 5.0.3, TypeScript 7.0.2, and esbuild 0.28.2. [Repository manifest](../package.json)

The docs app uses TypeScript 6.0.3 and `baseUrl` with a component alias. That is a concrete incompatibility with Oxlint's TypeScript Go checking path until its config changes or that app is excluded. Retain Astro's checks either way. Framework packages have separate `tsconfig.test.json` files; explicitly prove intended test coverage instead of assuming nearest-config discovery is sufficient. [Docs config](../apps/docs/tsconfig.json), [docs dependencies](../apps/docs/package.json), [core test config](../packages/core/tsconfig.test.json)

Read-only `pnpm exec tsc -p <package>/tsconfig.test.json --showConfig` inspection confirmed a current baseline gap: core selects five source files and zero `*.test.ts` files, CLI selects ten source files and zero test files, and the creator selects five files including its test. Core and CLI inherit `exclude: ["src/**/*.test.ts"]`. This research does not fix the configs, but a migration must address their intended type-test coverage rather than reproduce the omission. These commands inspect compiler configuration; they are not a compatibility test of Vite Plus.

Oxlint's `--tsconfig` controls import resolution, not type-aware project selection. The bundled tsgolint resolver searches normal configs, references, and ancestors, and can put unmatched files into an inferred program with different options. Such files are not necessarily skipped, but an inferred check is not proof of equivalent strict NodeNext checking. Retain explicit program checks until coverage is demonstrated. [Oxlint CLI](https://oxc.rs/docs/guide/usage/linter/cli), [bundled resolver](https://github.com/oxc-project/tsgolint/blob/v7.0.2004/internal/utils/find_tsconfig.go), [inferred-program options](https://github.com/oxc-project/tsgolint/blob/v7.0.2004/internal/utils/create_program.go)

The existing package outputs must survive a build migration:

| Package           | Required behavior                                                                                                                                   |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@routa-ts/core`  | Preserve the main, Hono, logger, and query-helper exports with matching declarations and valid ESM imports.                                         |
| `@routa-ts/cli`   | Emit `dist/index.js` and `dist/runtime.js`; preserve shebangs, compiler binary lookup, external dependencies, and installed `routa start` behavior. |
| `create-routa-ts` | Emit `dist/cli.js` and `dist/index.js`; preserve shebangs and unchanged generated-project contents.                                                 |

These requirements come from [build-package.mjs](../scripts/build-package.mjs), package manifests, and [pack-check.mjs](../scripts/pack-check.mjs). The CLI runtime is spawned by filesystem path, so following static imports is insufficient to discover it.

tsdown's Node-targeted builds default to fixed `.mjs`/`.cjs` extensions. Routa's export maps and runtime lookup currently require `.js` paths, so set `fixedExtension: false` for our ESM packages or configure explicit `outExtensions`, then inspect emitted declarations and paths. The TypeScript 7 declaration generator is itself marked experimental upstream; preserve a compiler-backed fallback until installed-consumer evidence passes. [Output-format options](https://tsdown.dev/options/output-format), [tsdown 0.23.1 defaults](https://github.com/rolldown/tsdown/blob/v0.23.1/src/config/options.ts), [declaration generator options](https://tsdown.dev/reference/api/Interface.DtsOptions)

Review package-check defaults rather than relying on generic examples. tsdown 0.23.1's implementation defaults ATTW to the ESM-only profile, while its guide still describes strict; choose the intended profile explicitly. Vite Plus's pack wrapper also defaults to failing on warnings, unlike standalone tsdown. This may matter when evaluating experimental declaration generation. [ATTW implementation](https://github.com/rolldown/tsdown/blob/v0.23.1/src/features/pkg/attw.ts), [package validation guide](https://tsdown.dev/options/lint), [released pack wrapper](https://github.com/voidzero-dev/vite-plus/blob/v1.3.0/packages/cli/src/pack-bin.ts)

`vp pack` builds library output; `vp pm pack` delegates tarball creation. Neither replaces packed installation tests. [Library build](https://viteplus.dev/guide/pack), [package-manager operations](https://viteplus.dev/guide/package-management)

Keep the following responsibilities with their current owner:

- Routa's route graph, generated metadata, OpenAPI validation, scaffold diagnostics, and dev/start lifecycle remain Routa commands.
- The CLI's TypeScript compiler API and compiler fallback remain runtime functionality.
- Astro remains responsible for docs/design dev, build, preview, and framework checks.
- Changesets remains responsible for release versions/changelogs and the existing publishing workflow.
- Scaffold dependencies, scripts, editor settings, and generated files retain the current defaults.

For example, `vp dev` starts Vite, while `vp run dev` runs a package's declared script. A future `vp run --filter @routa-ts/docs build` should still execute Astro. [Built-ins versus scripts](https://viteplus.dev/guide/run#built-in-commands-vs-scripts)

Standalone executables, CommonJS output, minification, CSS/asset bundling, and automatic export generation exist upstream but solve no current Routa requirement. Do not enable them merely because they are available. Standalone executables are experimental and require Node 25.7+ to build. Automatic exports must not silently redefine Routa's public subpaths. [Pack](https://viteplus.dev/guide/pack), [package exports](https://tsdown.dev/options/package-exports)

## Source discrepancies and release boundaries

The guides, released package, and upstream `main` can differ. These differences matter here:

1. During research, `main` documented TypeScript script execution/watch through `vpx` that was absent from the 1.3.0-tagged and deployed binary guide. This report does not count that as a released replacement for Routa's `tsx`. [Tagged guide](https://github.com/voidzero-dev/vite-plus/blob/v1.3.0/docs/guide/vpx.md), [main guide](https://github.com/voidzero-dev/vite-plus/blob/main/docs/guide/vpx.md)
2. The project-upgrade page includes legacy `package.json#pnpm.overrides` advice. The more specific migration rules state that pnpm 11 no longer reads legacy package.json settings. Routa pins pnpm 11.9.0, so put overrides in `pnpm-workspace.yaml` and verify the installed graph. [Upgrade page](https://viteplus.dev/guide/upgrade-project), [pnpm migration rules](https://viteplus.dev/guide/migrate-rules#pnpm)
3. The public run guide describes workspace ordering through `dependencies`, but the Vite Task revision in the published toolchain also recognizes `workspace:` entries in `devDependencies` and `peerDependencies`. Routa's CLI-to-creator edge qualifies. Define important task prerequisites explicitly rather than treating narrower guide wording as a proven missing capability. [Released package parser](https://github.com/voidzero-dev/vite-task/blob/9ba4cc93379cf2d7a6c7e657285bb8a00e8339dc/crates/vt_workspace/src/package.rs)
4. Remote-cache flags exist in that task-runner source but are hidden and explicitly marked unreleased. They are not a supported hosted service or a reason to promise Turbo cache interoperability. [Released CLI source](https://github.com/voidzero-dev/vite-task/blob/9ba4cc93379cf2d7a6c7e657285bb8a00e8339dc/crates/vt/src/cli/mod.rs)

## Evidence required before removing old tooling

A future migration should establish these results without weakening assertions or changing consumer defaults:

1. A passing current `pnpm verify` baseline, recorded package exports/files, scaffold output, and test counts.
2. A documented Biome-to-Oxlint/Oxfmt rule/config mapping, including any coverage gaps.
3. Matching source/test type-check coverage, including deliberate type errors and expected failures, with Astro checked separately.
4. Matching test execution, mocks, snapshots, HTTP/process behavior, and no new skips.
5. A correct task graph, followed by cache tests for unchanged runs, source/config/env changes, added route files, cross-package changes, and deleted output restoration.
6. Correct packed exports, declarations, shebangs, runtime entry, compiler lookup, installed starter checks/tests, and server startup.
7. Passing `pnpm verify`, docs/design builds, and explicit confirmation that scaffold output retains current tooling defaults.

Keep generation, packing, installation, and release validation uncached initially. Measure equivalent cold and warm workloads before reporting a speedup. This research performed source/artifact inspection only; no dependencies were installed and no framework compatibility or performance tests ran.
