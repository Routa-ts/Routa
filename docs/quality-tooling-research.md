# Code-quality tooling for Routa

Research checked on 2026-10-26 against official documentation, package manifests on the npm registry, tool source on GitHub, and measurements taken in a throwaway checkout. This note collects sourced facts and measured numbers. It makes no recommendation and does not approve any tool, script, dependency, or CI change.

## Question and scope

Which code-quality metrics and tools would have caught the defect classes that recently slipped past Routa's tests, and what does each cost on this toolchain?

The defect classes, taken from bugs that review caught on the Advanced response contracts stack:

1. A recursive walk sharing one visited `Set` across sibling branches.
2. `localeCompare` making generated output locale-dependent.
3. A reference resolver following only one hop.
4. A cache keyed by the wrong file.
5. Metadata projection disagreeing with the native `z.toJSONSchema` oracle.
6. A runtime whitelist disagreeing with TypeScript and CLI rules.
7. A `data: undefined` edge case that `exactOptionalPropertyTypes` would affect.

Candidates: StrykerJS mutation testing, Vitest coverage, complexity metrics, fast-check, type-level tests, package and API surface checks, stricter TypeScript flags, knip, fallow, and a few extras. Measurements ran against commit `d7a3725` (`origin/stack/advanced-response-contracts/07-migrate-qualify`). Statements about "this repository" describe that commit.

## Current state of the repository

Verified in the probe checkout:

- **Toolchain.** `vp --version` reports Vite Plus 1.3.0 with Vite 8.3.4, Rolldown 1.2.14, Vitest 5.0.5, Oxfmt 0.73.0, Oxlint 1.88.0, oxlint-tsgolint 7.0.2004, and tsdown 0.23.1. pnpm is 11.9.0. `typescript` is pinned to 7.0.2 in the root `package.json`. The probe's `vp` runs reported Node 24.22.1 (selected through `engines.node`); my shell's `node` was 24.18.0.
- **Vitest identity.** `vite-plus/test` is `export * from 'vitest'`, and Vite Plus depends on the real `vitest@5.0.5` package. `vitest` is not resolvable from the repository root unless a package depends on it directly.
- **Lint.** Root `vite.config.ts` enables Oxlint with `typeAware: true` and `typeCheck: true`, plugins `typescript`, `unicorn`, `oxc`, `node`, `import`, `vitest`, `promise`, and two `jsPlugins` (`eslint-plugin-import-x` aliased `dependency-checks`, and `eslint-plugin-no-secrets`). No complexity, depth, size, or restricted-property rule is configured.
- **TypeScript.** `tsconfig.base.json` sets `strict`, `declaration`, `verbatimModuleSyntax`, `skipLibCheck`, and `forceConsistentCasingInFileNames`. None of `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noImplicitOverride`, or `noPropertyAccessFromIndexSignature` is set. Each package's `typecheck` script runs `tsc -p tsconfig.json --noEmit` and `tsc -p tsconfig.test.json --noEmit`; the `tsc` binary is TypeScript 7.0.2.
- **Declarations.** Core and CLI build with `vp pack` and `dts: { generator: "tsgo" }`.
- **Tests.** 591 Vitest tests in 20 files: 211 in 10 files in `packages/core`, 367 in 9 files in `packages/cli`, and 13 in 1 file in `packages/create-routa-ts`. The sources contain 98 `@ts-expect-error` comments and zero `expectTypeOf` calls.
- **Existing oracle test.** `packages/cli/src/schema-contracts.test.ts` already compares the projector against `z.toJSONSchema` for chosen schemas (lines 13, 321, 648, 825) through a `semantic()` normalizer at line 1688. The inputs are hand-written cases, not generated ones.
- **No coverage provider installed.** `vp test run --coverage` fails with `MISSING DEPENDENCY  Cannot find dependency '@vitest/coverage-v8'`.
- **`localeCompare` in non-test source.** Eight lines at this commit: `packages/cli/src/project.ts` lines 778, 786, 898, 3058, 3101 and `packages/cli/src/openapi.ts` lines 535, 690, 698. I did not check whether each is user-visible output ordering.

## Candidates

### 1. Mutation testing: StrykerJS

**What it catches.** It changes source (negates a condition, swaps `&&` for `||`, empties a string, removes a block) and reruns the tests. A surviving mutant marks behavior that no test pins down. For Routa this targets the tests-pass-but-nothing-asserts class: defects 3 and 6, where a branch exists but no test distinguishes it, and defect 7 where `undefined` handling is untested. It does not find missing features or wrong specifications. [Vitest runner](https://stryker-mutator.io/docs/stryker-js/vitest-runner/)

**Versions and requirements.**

- Latest `@stryker-mutator/core`, `vitest-runner`, and `typescript-checker` on npm are all 10.1.1, with `engines.node >=22.0.0`. [core](https://registry.npmjs.org/@stryker-mutator/core/latest), [vitest-runner](https://registry.npmjs.org/@stryker-mutator/vitest-runner/latest), [typescript-checker](https://registry.npmjs.org/@stryker-mutator/typescript-checker/latest)
- The Vitest runner declares peer `vitest >=2.0.0` and peer `@stryker-mutator/core` at the same version. The docs name no supported Vitest versions and defer to the plugin's `package.json`. The runner source branches on `semver.gte(vitestWrapper.version, '5.0.0-0')`, so Vitest 5 is a known case in `master`. [vitest-test-runner.ts](https://github.com/stryker-mutator/stryker-js/blob/master/packages/vitest-runner/src/vitest-test-runner.ts)
- The runner imports `vitest/node` and reads `vitest/package.json`, first resolving from the current working directory. A `vitest` package must therefore be resolvable. It does not bundle one. [vitest-wrapper.ts](https://github.com/stryker-mutator/stryker-js/blob/master/packages/vitest-runner/src/vitest-wrapper.ts)
- Documented runner behavior: `vitest.related` defaults to `true` (runs only tests that import the mutated file); `coverageAnalysis` is ignored and `perTest` is always used; Vitest's own coverage is disabled; Browser Mode is unsupported. The troubleshooting page recommends `"vitest": { "pool": "forks" }` if tests fail under the default threads pool. [Troubleshooting](https://stryker-mutator.io/docs/stryker-js/troubleshooting/)

**Can it drive the Vitest inside Vite Plus?** Yes, with one extra dependency. I installed `vitest@5.0.5` (the version Vite Plus bundles) at the probe root next to the Stryker packages. Test files that import `vite-plus/test` ran correctly under Stryker (see measurements). Without a direct `vitest` dependency the wrapper cannot resolve `vitest/node`; I did not run that exact configuration. Adding `@vitest/coverage-v8` and `vitest` at the root made pnpm create three `vitest@5.0.5` directories in `node_modules/.pnpm` with different peer-set hashes. Vite Plus documents a `vitest@*` override so the project shares one Vitest copy with `vp test`. [Update Vite+](https://viteplus.dev/guide/upgrade-project) I did not isolate whether the duplicate copies caused any failure.

**TypeScript checker and TypeScript 7.** The checker type-checks each mutant in memory and marks non-compiling mutants `CompileError`, so tests do not run on them. It reads `tsconfig.json`, forces `allowUnreachableCode: true`, `noUnusedLocals: false`, and `noUnusedParameters: false`, and switches to `--build` mode when the tsconfig has project references. Peer `typescript >=3.6`. [TypeScript checker](https://stryker-mutator.io/docs/stryker-js/typescript-checker/)

Findings on this toolchain (10.1.1, `typescript@7.0.2`):

- The classic checker uses the JavaScript compiler API (`import ts from 'typescript'`). [typescript-checker.ts](https://github.com/stryker-mutator/stryker-js/blob/master/packages/typescript-checker/src/typescript-checker.ts) TypeScript 7.0 does not provide that classic API; the release post discusses a new API for 7.1. [Announcing TypeScript 7.0](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/) This does not mean 7.0 has no programmatic access: fallow's native companion pins 7.0.2 and uses `typescript/unstable/sync`. [fallow type-aware analysis](https://github.com/fallow-rs/fallow/blob/v3.36.0/docs/type-aware-analysis.md) The Stryker checker failed to initialize against 7.0.2: `Cannot read properties of undefined (reading 'fileExists')`.
- `master` also has `typescriptChecker.experimentalNativePreview`, which loads the native compiler's sync API. Its loader looks for `@typescript/native/unstable/sync` and falls back to `typescript/native/unstable/sync`. [load-typescript-native.ts](https://github.com/stryker-mutator/stryker-js/blob/master/packages/typescript-checker/src/ts-native/load-typescript-native.ts) TypeScript 7.0.2 exports `./unstable/sync`, not `./native/unstable/sync`. With the flag on, initialization failed: `Cannot read properties of undefined (reading 'readFile')`. I did not trace why; the path mismatch is my reading of the two sources.
- Stryker core itself calls the JS API in sandbox mode: `ts.parseConfigFileTextToJson` in its tsconfig preprocessor. With `typescript@7.0.2` as the resolvable `typescript`, a default run crashed with `ts.parseConfigFileTextToJson is not a function`. Setting `inPlace: true` skips that step, because the preprocessor returns early when `inPlace` is set; the run then mutates files in the working tree and restores them afterward. [ts-config-preprocessor.js in the 10.1.1 package](https://unpkg.com/@stryker-mutator/core@10.1.1/dist/src/sandbox/ts-config-preprocessor.js)
- The TypeScript 7 post says `typescript` 6 can run side by side: a `@typescript/typescript6` package re-exports the 6.0 API, and tools that import `typescript` should use an npm alias with 6 as `typescript` and 7 as `@typescript/native`. [Announcing TypeScript 7.0](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/) In the probe I forced `typescript@6.0.3` to be the module the Stryker packages resolve (symlink edits inside the probe's `node_modules/.pnpm`), and the checker then worked. That is a hack in a throwaway tree. The repository's own `typescript@7.0.2` direct dependency would conflict with a normal install.

**Incremental and changed-file modes.** `--incremental` (since Stryker 6.2) stores results in `reports/stryker-incremental.json` (`--incrementalFile` to change) and diffs mutated files and test files against the stored report. Killed mutants are reused if their killing test still exists unchanged; surviving mutants are reused if no test changed or was added. The dry run still happens every run. Only mutated files and test files are tracked: dependencies, snapshots, and environment variables are not. Vitest reports test changes in full detail. The page says nothing about persisting the file between CI runs. [Incremental](https://stryker-mutator.io/docs/stryker-js/incremental/) The docs do not describe a git-diff or changed-files mode; scoping is through `mutate` globs and line ranges such as `src/app.js:5-7`. [Configuration](https://stryker-mutator.io/docs/stryker-js/configuration/) I found no first-party "mutate only files changed in this branch" option.

**Other options that matter.** `thresholds.break` defaults to `null`, so a run never fails the build unless set. `ignoreStatic` skips mutants that run only at module load and requires `coverageAnalysis: "perTest"`. `concurrency` defaults to cores (or cores minus one above four). `timeoutMS` defaults to 5000. [Configuration](https://stryker-mutator.io/docs/stryker-js/configuration/)

**Evidence that mutation score tracks real faults.** Just et al. found a statistically significant correlation between mutant detection and real-fault detection, independent of code coverage, on 357 real faults in five Java programs. [FSE 2014](https://people.cs.umass.edu/~rjust/publ/mutants_real_faults_fse_2014.pdf) The result is for Java and for developer-written and generated suites; I did not find a JavaScript or TypeScript replication from a primary source.

**Limits.** Cost scales with mutants times test time (see measurements). Static mutants in module-level code (such as Routa's cookie name regexes) cannot be attributed to a test and show up as runtime errors, which Stryker leaves out of the score. Equivalent mutants (changes that do not change behavior) survive and need a human decision. Core and the checker depend on the TypeScript JS API.

### 2. Coverage: Vitest v8 and istanbul

**What it catches.** Code no test executes. It finds unexecuted branches (the cache-key and one-hop-resolver defects each needed an unexercised input shape, but coverage alone would only flag them if the branch itself were never run). It does not show whether tests assert anything. Inozemtseva and Holmes found only a low to moderate correlation between coverage and fault detection once suite size is controlled, and conclude coverage is a poor quality target but useful for finding under-tested code. [ICSE 2014](https://cs.ubc.ca/~rtholmes/papers/icse_2014_inozemtseva.pdf)

**Providers.** `v8` is the default. It uses native V8 coverage, runs faster with less memory than istanbul, and since Vitest 3.2.0 uses AST-based remapping that the docs say gives reports identical to istanbul's. `istanbul` instruments with Babel, works on any runtime, and is slower. Each needs its own package: `@vitest/coverage-v8` or `@vitest/coverage-istanbul`. [Coverage guide](https://vitest.dev/guide/coverage)

**Through `vp test` in Vite Plus 1.3.0.** The Vite Plus test guide shows `vp test run --coverage` and nothing else about coverage. It does not mention a provider package. [Test](https://viteplus.dev/guide/test) `vite-plus` does not depend on a coverage provider. I installed `@vitest/coverage-v8@5.0.5` (matching the bundled Vitest exactly) and ran per package with CLI flags only. No config file change was needed.

**Options verified in the Vitest 5.0.5 reference.** [Coverage config](https://vitest.dev/config/coverage)

- `coverage.include` defaults to files imported during the run, so unexercised files are absent unless `include` is set.
- `coverage.thresholds.{lines,functions,branches,statements}`: positive numbers are minimum percentages; negative numbers cap the count of uncovered items.
- `coverage.thresholds.perFile`: a boolean or an object; as a boolean each file is held to the top-level thresholds.
- `coverage.thresholds["<glob>"]` sets thresholds for matching files; globs do not inherit global thresholds or the top-level `perFile`.
- `coverage.thresholds.autoUpdate` rewrites the config file when coverage improves. `coverage.thresholds.100` is a shortcut.
- `coverage.changed` (CLI `--coverage.changed[=<commit/branch>]`) limits coverage to changed files.
- Default reporters are `text`, `html`, `clover`, `json`. In AI agent environments `text` sets `skipFull` and `text-summary` is added.

Observed: with `--coverage.thresholds.perFile --coverage.thresholds.branches=80`, the CLI package printed one `ERROR: Coverage for branches (…) does not meet global threshold (80%) for src/<file>` per failing file and exited with code 1.

**Branch versus line.** Both are reported. For this repository the branch figure is lower than the line figure in every package (measurements).

**Limits.** Only the package unit suites feed these numbers. Golden tests, the packed-consumer test, the scaffold smoke test, and example runs execute Routa code without being counted. Coverage on a hotspot file that is mostly exercised through a few large end-to-end tests can look high while asserting little.

### 3. Complexity metrics

**Which rules Oxlint 1.88.0 implements natively.** Verified two ways: a config naming an unknown rule fails with `Rule '…' not found in plugin 'eslint'`, and the five requested rules loaded and ran.

| Rule                     | Oxlint category | Default threshold                                           | Source                                                                                  |
| ------------------------ | --------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `complexity`             | restriction     | `max` 20                                                    | [docs](https://oxc.rs/docs/guide/usage/linter/rules/eslint/complexity.html)             |
| `max-depth`              | pedantic        | `max` 4                                                     | [docs](https://oxc.rs/docs/guide/usage/linter/rules/eslint/max-depth.html)              |
| `max-nested-callbacks`   | pedantic        | `max` 10                                                    | [docs](https://oxc.rs/docs/guide/usage/linter/rules/eslint/max-nested-callbacks.html)   |
| `max-lines-per-function` | pedantic        | `max` 50; options `skipBlankLines`, `skipComments`, `IIFEs` | [docs](https://oxc.rs/docs/guide/usage/linter/rules/eslint/max-lines-per-function.html) |
| `max-params`             | style           | `max` 3                                                     | [docs](https://oxc.rs/docs/guide/usage/linter/rules/eslint/max-params.html)             |

The `max-depth` page contradicts itself: the configuration section says the default is 4 and an example labels 3 as the default. `max-lines`, `max-statements`, and `max-classes-per-file` also loaded. `no-restricted-syntax` does not exist in 1.88.0; `no-restricted-properties` does (see item 9).

**What `complexity` counts.** The docs describe "the number of linearly independent paths" and show increments for `if`/`else if` chains, `&&=` and `||=`, parameter and destructuring defaults, optional chaining, and logical operators and ternaries in class field initializers; a `modified` variant counts a `switch` as one. Optional chaining and defaults make Oxlint's numbers higher than classic McCabe counts for the same function. [complexity](https://oxc.rs/docs/guide/usage/linter/rules/eslint/complexity.html)

**Cognitive complexity under `jsPlugins`.** Oxlint's JS-plugin page lists `eslint-plugin-sonarjs` among conformance-tested plugins. It calls JS plugins alpha, says rules that need type information are unsupported, and resolves relative specifiers from the config file. [JS plugins](https://oxc.rs/docs/guide/usage/linter/js-plugins.html) I installed `eslint-plugin-sonarjs@4.2.2` (peer `eslint ^8 || ^9 || ^10`) and ran `sonarjs/cognitive-complexity` at 15 through a config file placed in the probe root. It worked. The same config placed in `/tmp` failed with `Cannot find module 'eslint-plugin-sonarjs'`, because resolution starts at the config file. `cognitive-complexity` does not need type information.

**Do these metrics predict defects?** The evidence I could verify from primary sources is thin and mostly about something else:

- Landman, Serebrenik, and Vinju analyzed about 17.8 million Java methods and found cyclomatic complexity (CC) and lines of code only weakly to moderately correlated at method level, so CC is not simply redundant with size; the correlation strengthens when metrics are aggregated over larger units. [CWI record](https://ir.cwi.nl/pub/22662/), [Rascal blog summary](https://www.rascal-mpl.org/blog/2016/01/01/empirical-analysis-of-the-relationship-between-CC-and-SLOC/)
- A meta-analysis of about 24,000 understandability ratings across 427 snippets found Cognitive Complexity positively correlated with comprehension time and subjective understandability, with mixed results for comprehension correctness, and no threshold identified. This concerns understandability, not defects. [Muñoz Barón, Wyrich, Wagner, ESEM 2020](https://arxiv.org/abs/2007.12520)
- Herraiz and Hassan's chapter studies how size and complexity metrics relate (C code). I could read only its introduction. [Making Software, ch. 8](https://oreilly.com/library/view/making-software/9780596808310/ch08.html)

I did not find a primary source that shows complexity thresholds reduce defect counts in TypeScript or JavaScript libraries. Treat the metrics as a review-effort signal.

**Limits.** Complexity flags where defects might hide, not whether they exist. Large `switch` projectors and visitors score high but read linearly. Thresholds on legacy code need a baseline or an allow-list.

### 4. Property-based testing: fast-check and `@fast-check/vitest`

**What it catches.** It generates many inputs and shrinks a failure to a minimal case. Fit for Routa:

- _Oracle comparison_ (defects 3 and 5). Generate Zod schemas, project them with the static analyzer, and compare to `z.toJSONSchema` through the existing `semantic()` normalizer. Today the test uses chosen schemas. Writing the schema generator is the large part of the work; the library does not supply one.
- _Round trips_ (cookies, headers). Encode then decode and check equality, or check the output stays within RFC 6265 octets.
- _Determinism_ (defect 2). Run the generator twice or on shuffled inputs and compare byte-for-byte.
- _Shared-state bugs_ (defect 1). Generate branching structures with repeated sub-nodes to hit sibling-sharing and one-hop-reference cases.

**Compatibility.** `@fast-check/vitest` 0.5.0 declares peer `vitest ^4.1.0 || ^5.0.0` and depends on `fast-check ^3 || ^4`; latest `fast-check` is 4.10.2. [@fast-check/vitest](https://registry.npmjs.org/@fast-check/vitest/latest), [fast-check](https://registry.npmjs.org/fast-check/latest) It adds `.prop` to Vitest's `test` and `it`, with record or tuple notation, sync or async predicates, and a per-test context function `g`. A failing run prints a seed; replay it with `fc.configureGlobal({ seed })`. [Vitest tutorial](https://fast-check.dev/docs/tutorials/setting-up-your-test-environment/property-based-testing-with-vitest/) The docs I fetched do not state the default `numRuns`.

In the probe (clean install, one Vitest copy) a property test importing `describe` and `expect` from `vite-plus/test` and `test` and `fc` from `@fast-check/vitest` ran under plain `vp test run` without special config. Options go as the second argument of `test.prop(arbitraries, { numRuns })`; passing them as a third argument to the returned function fails with Vitest's "Signature … was removed in Vitest 4" error. An earlier attempt in a tree with several Vitest copies produced `Vitest failed to find the current suite`; I did not establish whether the cause was the copies or the call signature.

**Limits.** Properties need an oracle or an invariant. Generators for Zod schemas and TypeScript sources are custom work. Failures are randomized unless the seed is fixed in CI.

### 5. Type-level testing

**Current approach.** 98 `@ts-expect-error` comments, checked by `tsc -p tsconfig.test.json --noEmit` per package. Oxlint's `typescript/ban-ts-comment` allows `ts-expect-error` and bans `ts-ignore` and `ts-nocheck`. An unused `@ts-expect-error` is itself a compiler error, so a compile-fail case that stops failing is caught.

**Vitest typecheck mode.** `typecheck.enabled`, `typecheck.only`, `typecheck.checker` (`tsc`, `vue-tsc`, or a custom command producing `tsc --noEmit --pretty false` output), `typecheck.include` (default `**/*.{test,spec}-d.?(c|m)[jt]s?(x)`), `typecheck.tsconfig`, `typecheck.ignoreSourceErrors`. The 5.0.5 reference marks it experimental and does not mention tsgo or TypeScript 7. [Typecheck config](https://vitest.dev/config/typecheck) The testing-types guide timed out when fetched, so `expectTypeOf` behavior below comes from the probe, not the guide.

In the probe, a `src/*.test-d.ts` file importing `expectTypeOf` from `vite-plus/test` ran through `vp test run --typecheck.only` using the `tsc` binary of TypeScript 7.0.2. A deliberate `toEqualTypeOf<{ a: number }>()` mismatch against `z.infer` failed with a `TypeCheckError` pointing at the line, and the file reported in 0.7 s. So Vitest typecheck mode works with the TypeScript 7 `tsc` for that case. What it adds over `@ts-expect-error` is exact-type assertions (`toEqualTypeOf`) rather than only "does not compile"; a `@ts-expect-error` passes for any error, including an unrelated one. `ignoreSourceErrors` is `false` by default, so source type errors also fail the run.

**Limits.** Experimental status per the docs. Type tests that depend on inference-heavy generics can be slow under any checker; I did not measure that on a large Routa type test.

### 6. Package and API surface

**`@arethetypeswrong/cli` (attw) 0.18.5.** Analyzes a packed tarball for type-resolution problems under `node10`, `node16` (CJS and ESM), and `bundler` resolution. Profiles: `strict` (all), `node16` (ignores node10 failures), `esm-only` (ignores CJS failures). `--pack` uses `npm pack` only; for pnpm, create the tarball with `pnpm pack`. `--ignore-rules` and `.attw.json` are supported. [README](https://github.com/arethetypeswrong/arethetypeswrong.github.io/blob/main/packages/cli/README.md) On the packed `@routa-ts/core`, `@routa-ts/cli`, and `create-routa-ts` 0.5.0 tarballs, the default `strict` profile reports `Resolution failed` under node10 and `ESM (dynamic import only)` from node16-CJS for every entry point, which describes ESM-only packages. With `--profile esm-only` both are marked ignored and the exit code is 0; node16-from-ESM and bundler are green for all four `@routa-ts/core` export paths.

**`publint` 0.3.25.** Lints package metadata and layout for compatibility. The home page does not list rules or CI flags. [publint.dev](https://publint.dev/) `publint --strict` in each package directory (it runs `pnpm pack` itself) printed `All good!` for all three packages.

**`@microsoft/api-extractor` 7.59.4.** It depends on `typescript@5.9.3` and prints `Analysis will use the bundled TypeScript version 5.9.3`, so it does not use the repository's TypeScript 7. [npm manifest](https://registry.npmjs.org/@microsoft/api-extractor/latest) It reads `.d.ts` files, which is why it works on tsgo output. Pointed at `packages/core/dist/index.d.ts`, it produced a 342-line API report and finished in about 0.5 s; the compiler tsconfig needed `skipLibCheck`. It emitted `ae-missing-release-tag` warnings for each exported name and two TSDoc syntax warnings about braces in a comment, because Routa does not use release tags. The report file is meant to be committed so signature changes appear as pull-request diffs. [API report config](https://api-extractor.com/pages/setup/configure_api_report/) One configuration covers one `mainEntryPointFilePath`; `@routa-ts/core` has four export paths (`.`, `./query/helpers`, `./hono`, `./logger`), so full coverage needs more than one configuration or a single barrel. I did not confirm multi-entry support from the docs I could fetch. I found no first-party statement that API Extractor supports TypeScript 7; the probe result shows it analyzes its own bundled 5.9.3 against the emitted declarations.

**Limits.** None of the three checks runtime behavior. attw and publint need a tarball; the repository already has a packed-consumer script (`scripts/pack-check.mjs`), which I did not read for overlap.

### 7. Stricter TypeScript flags

The tsconfig reference lists all four options as separate settings, none part of `strict`. [TSConfig reference](https://www.typescriptlang.org/tsconfig/)

| Flag                                       | What it does                                                                                                                        |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- |
| `exactOptionalPropertyTypes` (4.4)         | "makes TypeScript truly enforce the definition provided as an optional property": `{ a?: string }` rejects an explicit `undefined`. |
| `noUncheckedIndexedAccess` (4.1)           | "will add `undefined` to any un-declared field" read through an index signature or array index.                                     |
| `noImplicitOverride` (4.3)                 | Requires the `override` keyword on overriding members.                                                                              |
| `noPropertyAccessFromIndexSignature` (4.2) | Requires `obj["key"]` rather than `obj.key` for properties declared only by an index signature.                                     |

The TypeScript 7 post says 7.0 matches 6.0's type-checking and command-line behavior and makes `strict` default to `true`. [Announcing TypeScript 7.0](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/) I did not verify whether Oxlint's `typeCheck` path (tsgolint) reads these options from `tsconfig` the same way `tsc` does.

Measured error counts are in the measurements section. In `src`, the `exactOptionalPropertyTypes` errors are all `X | undefined` values passed where `X?` is declared (for example `packages/core/src/hono.ts:109` passing `lifecycleHeaders: boolean | undefined`), which is the explicit-`undefined` versus absent distinction behind the `data: undefined` defect. The one `noUncheckedIndexedAccess` error in core source is `packages/core/src/request-execution.ts:412` (`'mediaRange' is possibly 'undefined'`).

**Limits.** Each flag changes what library consumers see only if declarations expose the affected types; they are checked in Routa's own compilation. `noPropertyAccessFromIndexSignature` is the noisiest and the least tied to the defect classes above.

### 8. Dead code and dependency hygiene: knip

Knip 6.43.0, `engines.node ^20.19.0 || >=22.12.0`. [npm](https://registry.npmjs.org/knip/latest) Its plugin list includes Vitest, Vite, tsdown, Oxlint, and Changesets, plus a pnpm plugin; the page has no TypeScript 7 note. [Plugins](https://knip.dev/reference/plugins) Zero-config run on the repository root: 0.97 s wall time. It found items in these categories: files 51, dependencies 11, devDependencies 9, exports 8, types 6 (JSON reporter counts, including probe-added devDependencies). Of the 51 "unused files", the list is dominated by `examples/**` route files, generated `.routa/routes.gen.ts` files, and `scripts/*.mjs`, which are entry points by Routa convention and need configuration. The package-restricted measurement list below contains one unused dependency (`tsx` in `packages/cli`), eight unused exports, and six unused exported types. This corrects the earlier prose totals of six exports and three types to match that list; Knip was not rerun for the fallow comparison. Whether `tsx` is used dynamically I did not check.

**What it catches.** Exports and files nothing imports, and declared dependencies nothing uses. This relates to the runtime-whitelist class only indirectly (two copies of a rule where one is dead), and to dependency drift. **Limits.** Convention-based entry points (Routa routes), dynamic imports, and published public exports need configuration to avoid false positives.

### 9. Other candidates with primary-source support

**CodeQL default setup for JavaScript/TypeScript.** The docs say analysis of JavaScript/TypeScript "does not currently require special configuration", the scan runs on a weekly schedule that is turned off after six months without pushes or pull requests, and default setup overrides existing code-scanning configurations and blocks CodeQL analysis API uploads. Query suites are chosen in the setup dialog. The page does not name the suites or state the cost for public repositories. [Configuring default setup](https://docs.github.com/en/code-security/code-scanning/enabling-code-scanning/configuring-default-setup-for-code-scanning) This targets security-shaped bugs (injection, unsafe regex, prototype pollution), not the correctness classes listed above.

**Native type-aware Oxlint rules not currently enabled.** With `--type-aware` and one-rule configs, source-only hit counts on the three packages: `typescript/no-unnecessary-condition` 56, `typescript/switch-exhaustiveness-check` 1, `typescript/no-unnecessary-type-assertion` 15, `typescript/strict-boolean-expressions` 167, `typescript/no-unsafe-assignment` 4, `typescript/no-unnecessary-type-arguments` 3, `typescript/no-base-to-string` 0, `typescript/restrict-template-expressions` 0. The `no-unnecessary-condition` hits in `packages/core/src/request-execution.ts` include `:835` ("This condition will always return the same value since the types have no overlap", left `string`, right `undefined`) and `:140` and `:197` ("value is always falsy"). That is the shape of a runtime check that disagrees with the declared types (defect 6), and also the shape of an intentional defensive check on values the type system calls impossible; this file validates `unknown` handler output, so some hits are deliberate. I did not triage them.

**Banning a locale-dependent API.** Oxlint's `no-restricted-properties` works with `{ "property": "localeCompare" }` and, with that option, flagged all three `localeCompare` calls in `packages/cli/src/openapi.ts` (lines 535, 690, 698). `no-restricted-syntax` is not available in 1.88.0. Default-locale effects are real in Node 24.18.0 on this machine: the same array sorted with `localeCompare` under `LC_ALL`/`LANG` set to `en_US.UTF-8`, `sv_SE.UTF-8`, and `tr_TR.UTF-8` gives three different orders (see measurements). A CI step that runs the generator under a second locale and diffs the output would test determinism directly; I did not build that.

**`@typescript/typescript6` side-by-side.** Only relevant if a tool in this list needs the JS API (Stryker). See item 1.

## fallow

### Identity, licensing, and command boundaries

Checked 2026-10-26. npm `fallow/latest` and the executable selected by `npx -y fallow@3` both report **3.36.0**; the release was published 2026-10-25. The package and repository license are MIT. The npm launcher requires Node >=22; the native Rust analyzer uses Oxc and its default static analysis needs neither the TypeScript compiler nor Node. Node 24 satisfies the launcher requirement. [npm manifest](https://registry.npmjs.org/fallow/latest), [release](https://github.com/fallow-rs/fallow/releases/tag/v3.36.0), [license](https://github.com/fallow-rs/fallow/blob/v3.36.0/LICENSE), [README](https://github.com/fallow-rs/fallow/blob/v3.36.0/README.md)

The local analysis commands below ship in the MIT repository and do not require a paid license. Runtime coverage has a separate commercial boundary. These are distinct commands, rather than different names for one check. [README](https://github.com/fallow-rs/fallow/blob/v3.36.0/README.md), [runtime coverage licensing](https://docs.fallow.tools/analysis/runtime-coverage/)

| Command              | What it measures or catches                                                                                                                  | Compatibility and limits                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dead-code`          | Unreachable files, unused exports/types/members/dependencies, plus graph findings such as cycles.                                            | Uses entry-point reachability, not TypeScript diagnostics. pnpm workspaces and framework plugins supply roots; Routa's generated graph needs configuration. [Dead-code reference](https://docs.fallow.tools/analysis/dead-code/)                                                                                                                                                                                                          |
| `health`             | Cyclomatic/cognitive complexity, estimated or measured CRAP, file maintainability, git-churn hotspots, refactoring targets, aggregate score. | Default Rust/Oxc pass works with TS 7 source. Estimated coverage is graph evidence, not Vitest coverage. [Health definitions](https://docs.fallow.tools/explanations/health/)                                                                                                                                                                                                                                                             |
| `dupes`              | Token/structural clones in JS/TS, CSS, Vue, Svelte, and Astro; optional near-miss clones.                                                    | Strict/mild remove formatting/comments; semantic mode normalizes identifiers/literals. Defaults: 50 tokens, 5 lines, 2 instances. Near-miss detection requires at least 80% shingle similarity. It cannot establish semantic equivalence between a type-level conditional and a runtime validator. [Duplication](https://docs.fallow.tools/analysis/duplication/)                                                                         |
| `architecture`       | Import cycles, configured boundary violations, rule-pack policy violations.                                                                  | Zero boundary violations without configured boundaries means the detector did not run. `guard <files>` instead reports the rules that apply before editing; it is not a cycle scan. [Boundaries](https://docs.fallow.tools/analysis/boundaries/), [guard source](https://github.com/fallow-rs/fallow/blob/v3.36.0/crates/cli/src/guard.rs)                                                                                                |
| `audit --base <ref>` | Changed-file gate combining dead code, complexity, duplication, and styling.                                                                 | Builds base/head evidence; default `new-only` gate excludes inherited findings. Worsened matched complexity defaults to a warning. It does not run mutation or security analysis. [Audit](https://docs.fallow.tools/cli/audit/), [security boundary](https://docs.fallow.tools/cli/security/)                                                                                                                                             |
| `mutation`           | Whether tests detect small source changes; runtime mutant/test coverage.                                                                     | Runs project tests through a companion; supports Vitest 4.1 through 5, Node test runner 22.18 through 26, Bun 1.4 through 1.x. Directly resolvable Vitest is required, including when tests use `vite-plus/test`. [Mutation contract](https://github.com/fallow-rs/fallow/blob/v3.36.0/docs/mutation-testing.md), [Vitest loader](https://github.com/fallow-rs/fallow/blob/v3.36.0/crates/api/src/mutation/companion/adapters/vitest.mjs) |
| `security`           | Local secret/client reachability and a catalogue of dangerous-sink candidates, with traces and ranking.                                      | Opt-in, separate from `audit`; findings are candidates for verification, not proven vulnerabilities or a complete SAST result. `--gate new` and `--gate newly-reachable` have a dedicated exit code. [Security reference](https://docs.fallow.tools/cli/security/)                                                                                                                                                                        |

The paid add-on is Fallow Cloud runtime coverage for continuous or multiple captures. A single local capture is free without a license. This differs from free `health --coverage`, which accepts local Istanbul/raw V8 test coverage for CRAP. License verification is offline; trial activation and refresh contact the service. Expiry permits 7 days normally, days 8–30 with a watermark, then blocks runtime coverage with exit **3**. Invalid/missing required entitlement also uses 3, including a single capture when an invalid license is present. No paid add-on, trial, cloud call, or upload was used here; monetary pricing is **unverified**. [Runtime coverage](https://docs.fallow.tools/analysis/runtime-coverage/), [health coverage configuration](https://github.com/fallow-rs/fallow/blob/v3.36.0/crates/config/src/config/health.rs)

### Complexity and the health score

Cyclomatic complexity starts at 1 per function. The visitor increments for `if`, loops, non-default switch cases, `catch`, ternaries, logical/nullish operators and assignments, and optional chaining. Cognitive complexity adds structural increments weighted by nesting, boolean-operator sequence changes, and labelled jumps; optional chaining adds no cognitive point. Each function/method/arrow has an independent frame. This is related to, but numerically different from, Oxlint and sonarjs; see the measured comparison below. [Visitor source](https://github.com/fallow-rs/fallow/blob/v3.36.0/crates/extract/src/complexity.rs)

Default finding thresholds are cyclomatic **>20**, cognitive **>15**, CRAP **>=30**, and unit size **>60 lines**. `health.maxCyclomatic`, `maxCognitive`, `maxCrap`, `maxUnitSize`, per-file/per-function `thresholdOverrides`, and CLI overrides configure findings. CRAP is `CC² × (1 − coverage/100)³ + CC`. Without a coverage file, the graph estimates 85% for directly test-referenced functions, 40% for transitively reachable functions, and 0% for untested functions. Those estimates do not replace the measured 93.01% core or 82.51% CLI branch coverage above. The new `cyclomaticPolicy: "literal-membership"` can count a strict literal-membership chain as one predicate for findings and CRAP; the standard count remains in score/density/hotspot calculations. [Configuration source](https://github.com/fallow-rs/fallow/blob/v3.36.0/crates/config/src/config/health.rs), [health definitions](https://docs.fallow.tools/explanations/health/), [3.36 release](https://github.com/fallow-rs/fallow/releases/tag/v3.36.0)

Hotspot score is `100 × (weighted commits / maximum weighted commits) × (complexity density / maximum density)`. Complexity density is total cyclomatic complexity divided by file lines. Commit weights decay exponentially with a 90-day half-life. Default history is six months and at least three commits, configurable with `--since` and `--min-commits`. The descriptive hotspot bands are 70–100 critical, 40–70 moderate, and below 40 low; the score's hotspot count uses a separate fixed cutoff of **>=50**. [Hotspot definitions](https://docs.fallow.tools/explanations/health/#hotspot-metrics), [hotspot source](https://github.com/fallow-rs/fallow/blob/v3.36.0/crates/engine/src/health/hotspots.rs), [fixed calibration](https://github.com/fallow-rs/fallow/blob/v3.36.0/crates/output/src/health_scores.rs)

Overall health formula v3 is `clamp(100 − sum(penalties), 0, 100)`. Grades are A >=85, B >=70, C >=55, D >=40, F <40. The calibration is fixed, independently of configurable finding thresholds; `health.ignore` changes the analyzed population, and `--min-score` configures a CI floor. Cognitive complexity does not directly feed the overall score. The complexity penalty uses the share with standard cyclomatic >=50, so a project can have many complexity findings and no complexity-score penalty. [Health score](https://docs.fallow.tools/explanations/health/#health-score), [health config](https://github.com/fallow-rs/fallow/blob/v3.36.0/crates/config/src/config/health.rs), [score constants](https://github.com/fallow-rs/fallow/blob/v3.36.0/crates/output/src/health_scores.rs)

| Penalty                      | Formula, capped as shown                                          |
| ---------------------------- | ----------------------------------------------------------------- |
| Dead files / exports         | Each `min(percent × 0.2, 15)`                                     |
| Critical complexity          | `min(critical_complexity_pct × 4, 20)`; P90 penalty is zero in v3 |
| Low maintainability          | `min(maintainability_low_pct × 1.5, 15)`                          |
| Hotspots                     | `min(hotspot_count / max(ceil(files × 0.01), 1) × 10, 10)`        |
| Unused dependencies / cycles | Each `min(count_per_1000_files × 0.5, 25)`                        |
| Unit size                    | `min(functions_over_60_LOC_per_1000 × 0.5, 10)`                   |
| Coupling                     | `min(high_coupling_pct × 0.5, 5)`                                 |
| Duplication                  | `min(max(0, duplication_pct − 5), 10)`                            |
| Opt-in prop drilling         | `min(chain_count, 5)` when that rule runs                         |

All formulas in this table are from the [health score reference](https://docs.fallow.tools/explanations/health/#health-score). They are a tool-defined rubric, not measured defect probabilities.

### Mutation behavior and TypeScript 7

The Rust planner generates and instruments mutants into its cache, leaving project source untouched. A runner companion collects runtime hits, selects covering tests, executes mutants, retries survivors/timeouts, and reports per-mutant evidence. It checks whether tests changed the worktree. Static/module-load mutants receive tests from files that load them. `--plan` runs no project code. The optional `--typecheck` checks survivors afterward; it is not the default. [Mutation design](https://github.com/fallow-rs/fallow/blob/v3.36.0/docs/mutation-testing.md)

There are 13 operator families: arithmetic, relational, logical, negate-condition, unary, update, removed-call, return-value, boolean-literal, string-literal, optional-chaining, regex-literal, and removed-chain-link. The last removes a fluent link in a module-level `const`, including schema calls such as `.int()` or `.positive()`; it does not mutate every fluent call. These are different operators and filtering rules from Stryker's, so scores are not interchangeable. Fallow's score is `(killed + timeout) / (killed + timeout + survived)`; `no_coverage`, runtime errors, compile errors, equivalent/flaky/pending/pruned mutants are excluded. Unlike the recorded Stryker score, uncovered mutants therefore do not lower fallow's score. [Operators and scoring](https://github.com/fallow-rs/fallow/blob/v3.36.0/docs/mutation-testing.md)

Changed code against the detected audit base is the default scope; explicit paths, `--all`, `--changed-since`/`--base`, and unified diffs are available. `--max-mutants` and `--time-budget` bound execution. Results cache to `.fallow/mutation/results.json`; a dry run still happens. The cache keys source, covering tests and static dependencies, runtime/runner/tool versions, lockfiles, and relevant root configs. Unresolved dynamic imports, arbitrary file reads, and non-root workspace config changes are documented gaps. Workspace flags are rejected by mutation v1; use directory paths. [Scopes and cache](https://github.com/fallow-rs/fallow/blob/v3.36.0/docs/mutation-testing.md)

Default mutation planning/execution does not call the classic TypeScript JavaScript compiler API. The optional semantic companion pins TypeScript **7.0.2** and uses its native `typescript/unstable/sync` API. That avoids the specific classic-API failure observed with Stryker. This is a source-level compatibility fact, separate from the local runner measurements. [Type-aware architecture](https://github.com/fallow-rs/fallow/blob/v3.36.0/docs/type-aware-analysis.md), [companion manifest](https://github.com/fallow-rs/fallow/blob/v3.36.0/tools/type-aware-sidecar/package.json)

For maturity, the published mutation contract calls its output/schema and restrictions **version 1** and limits output to human/JSON. It explicitly has no mutation SARIF, LSP, GitHub Action, or GitLab surface. Stryker's 10.1.1 pilot in this note has a different operator set and incremental implementation. An independent reliability comparison or whole-Routa comparison is **unverified**; neither version numbering nor this one-file pilot establishes parity. [Mutation v1 contract](https://github.com/fallow-rs/fallow/blob/v3.36.0/docs/mutation-testing.md)

### Entry points, CI, and agent integration

Dead-code analysis walks from package entry points and framework-discovered roots. The built-in list explicitly includes Vite, Vitest, Astro, and **Vite+**. Vite+ activates the Vitest plugin without a direct Vitest dependency, reads `test`, `pack.entry`, and `lint.jsPlugins` blocks in `vite.config.*`, and recognizes `vite-plus/test` mocks. This static-plugin support does not change the mutation companion's separate `vitest/node` resolution requirement. pnpm workspace discovery and `--workspace` filters are supported. Public entry exports are kept by default; `--include-entry-exports` changes that. User `entry`, `ignorePatterns`, `ignoreExports`, `ignoreDependencies`, and suppression comments handle additional conventions. [Framework plugins](https://docs.fallow.tools/frameworks/built-in/), [README entry behavior](https://github.com/fallow-rs/fallow/blob/v3.36.0/README.md), [configuration](https://docs.fallow.tools/configuration/overview/)

The probe emitted three `skipped-source-dotdir` diagnostics for generated `.routa/` directories. Their messages explicitly say imports/exports are not analyzed and dependent findings may be false positives. They suggest `!examples/.../.routa/**` in `ignorePatterns` to include them, or explicit entry roots/suppressions. Blindly excluding these generated graphs would preserve the reachability gap. No config was added to fix that in this probe. The source warns through `workspace_diagnostics[].degrades_analysis`, and the measured findings carry `incomplete-import-graph` caveats. [Discovery/config semantics](https://docs.fallow.tools/configuration/overview/), [diagnostic output contract](https://github.com/fallow-rs/fallow/blob/v3.36.0/docs/output-schema.json)

The GitHub Action is `uses: fallow-rs/fallow@v3` with `command: audit`; `fetch-depth: 0` is recommended, and the Action can fetch a missing merge base in a shallow PR checkout. It supports report-only operation, annotations, PR/review comments, and SARIF. SARIF upload is free for public repositories; private/internal repositories require GitHub Advanced Security. CLI version selection is independent of the Action ref: an explicit Action `version`, the project's dependency spec, or latest. No Action or comment was installed/run here. [README CI](https://github.com/fallow-rs/fallow/blob/v3.36.0/README.md#in-pull-requests), [Action inputs](https://github.com/fallow-rs/fallow/blob/v3.36.0/action.yml)

`audit --base origin/main` compares the changed files with the base snapshot without requiring a saved baseline. `--gate all` includes inherited findings; `--worsened warn|error|off` controls growth in matched complexity. Full dead-code/health/dupes/architecture runs accept saved baselines; combined mode needs separate health/duplication baseline paths. Health defaults to count-based matching per file/category; `--baseline-mode identity` additionally keys by function name, with documented collisions for duplicate/anonymous names and sensitivity to moves/renames. [Audit gate](https://docs.fallow.tools/cli/audit/), [global baseline flags](https://docs.fallow.tools/cli/global-flags/)

Exit codes: **0** for pass/warn, **1** for a failed ordinary gate, **2** for input/execution failure, **3** for unavailable config/license resources, **4/5/6** for runtime-coverage companion/input/internal failures, **7** for network/cloud failure, **8** for a selected security gate, and **10–13** for upload validation/size/auth/server failures. Command details matter: mutation survivors do not fail without `--min-score`; duplication uses its configured gate/`--fail-on-issues`. The probes recorded actual exits below. [Exit-code source](https://github.com/fallow-rs/fallow/blob/v3.36.0/crates/cli/src/exit_codes.rs), [README exit contract](https://github.com/fallow-rs/fallow/blob/v3.36.0/README.md#in-pull-requests), [mutation exits](https://github.com/fallow-rs/fallow/blob/v3.36.0/docs/mutation-testing.md#exit-codes)

Config discovery order is `.fallowrc.json`, `.fallowrc.jsonc`, `fallow.toml`, `.fallow.toml`, searching upward to the workspace root. JSON forms accept JSONC. The schema ships as `fallow/schema.json` or `./node_modules/fallow/schema.json`; the docs also publish the repository schema URL. Agent skills describe commands, flags, output interpretation, and analysis/setup workflows. `agent install` can also write an AGENTS task map, register MCP, and install commit/push gates, so it is an installation/mutation step, not a read-only analysis command. None was invoked. [Config reference](https://docs.fallow.tools/configuration/overview/), [schema](https://github.com/fallow-rs/fallow/blob/v3.36.0/schema.json), [agent skills](https://docs.fallow.tools/integrations/agent-skills/)

### Overlap with the existing candidates

This table describes capability overlap, not an adoption recommendation. Measured comparisons refer to the measurements in this note.

| Existing tool/check                                        | Relationship                                           | Evidence and remaining boundary                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| knip                                                       | Overlapping candidate replacement, not verified parity | Fallow covers dead code/dependencies and matches 7 of the 8 enumerated package exports; it misses `startRuntime`, `tsx`, and all 6 listed type findings in this run. Both need Routa roots configured. [Dead-code model](https://docs.fallow.tools/analysis/dead-code/)                                                                                            |
| Oxlint `complexity`                                        | Overlapping metric replacement, not a lint replacement | Both find 16 package-source functions >20, but scores differ. Fallow adds git churn and a score; it does not replace Oxlint's broader lint/type-aware rules. [Health visitor](https://github.com/fallow-rs/fallow/blob/v3.36.0/crates/extract/src/complexity.rs), [type-aware scope](https://github.com/fallow-rs/fallow/blob/v3.36.0/docs/type-aware-analysis.md) |
| sonarjs cognitive complexity                               | Overlapping metric replacement with different counts   | Fallow finds 33 package-source functions >15 versus 30; `project.ts:1657` is 48 versus 46. Thresholds/reports cannot be assumed interchangeable. [Cognitive implementation](https://github.com/fallow-rs/fallow/blob/v3.36.0/crates/extract/src/complexity.rs)                                                                                                     |
| StrykerJS                                                  | Overlapping mutation candidate, not verified parity    | Fallow supports native TS 7 semantics, a changed-code scope, and cached runs; operators, score denominator, and runner setup differ. Pilot numbers appear below. [Mutation contract](https://github.com/fallow-rs/fallow/blob/v3.36.0/docs/mutation-testing.md)                                                                                                    |
| Vitest v8/istanbul coverage                                | Complements                                            | Consumes measured coverage for CRAP; graph-estimated coverage and mutation coverage do not supply statement/branch/line coverage. [Health coverage inputs](https://docs.fallow.tools/explanations/health/)                                                                                                                                                         |
| fast-check / `@fast-check/vitest`                          | Complements                                            | Mutation checks existing assertions; it does not generate property inputs, shrink counterexamples, or supply a Zod projection oracle. [Mutation scope](https://github.com/fallow-rs/fallow/blob/v3.36.0/docs/mutation-testing.md)                                                                                                                                  |
| `@ts-expect-error` / Vitest type tests                     | Does not cover                                         | Mutation does not execute type tests; optional survivor typecheck is not a type-test suite. [Type-test boundary](https://github.com/fallow-rs/fallow/blob/v3.36.0/docs/mutation-testing.md#type-tests)                                                                                                                                                             |
| `exactOptionalPropertyTypes` and the other strict TS flags | Does not cover                                         | Fallow's optional semantic pass does not emit compiler diagnostics or typed lint findings; it cannot substitute for the recorded 15 exact-optional and 14 indexed-access source errors. [Type-aware scope](https://github.com/fallow-rs/fallow/blob/v3.36.0/docs/type-aware-analysis.md)                                                                           |
| attw                                                       | Does not cover                                         | A source graph/API query is not a packed-consumer type-resolution test across Node/bundler modes. [Fallow capability scope](https://github.com/fallow-rs/fallow/blob/v3.36.0/README.md)                                                                                                                                                                            |
| publint                                                    | Does not cover                                         | Workspace/package dependency hygiene does not establish tarball/package-layout compatibility. [Fallow capability scope](https://github.com/fallow-rs/fallow/blob/v3.36.0/README.md)                                                                                                                                                                                |
| API Extractor                                              | Complements                                            | Type-aware package API queries overlap inspection, but a committed declaration API report/compatibility gate is not established by the documented fallow capabilities. Such replacement is **unverified**. [Type-aware package API scope](https://github.com/fallow-rs/fallow/blob/v3.36.0/docs/type-aware-analysis.md)                                            |
| CodeQL                                                     | Complements                                            | Fallow's local sink/reachability candidates need verification; no equivalent vulnerability-analysis coverage is established. [Security limits](https://docs.fallow.tools/cli/security/)                                                                                                                                                                            |
| Oxlint locale API ban / locale determinism test            | Does not cover                                         | Complexity/clones/mutation do not enforce a `localeCompare` prohibition or execute generation under multiple locales. Neither is documented as a fallow capability. [Command inventory](https://github.com/fallow-rs/fallow/blob/v3.36.0/README.md)                                                                                                                |

### Open questions

- Configured Routa entry points, inclusion of generated `.routa/` imports, and optional `--type-aware` dead-code refinement were not measured. Whether those reconcile the missing knip findings is **unverified**.
- Static framework support for Vite+ is documented; a supported manifest-level way to expose its bundled Vitest to fallow mutation without adding a direct Vitest dependency is **unverified**. The node_modules-only shim below is probe evidence, not an installation recipe.
- Whether a custom duplication threshold/rule pack can catch the repeated header/cookie/name policy across type-level declarations, runtime, and CLI is **unverified**. Default and semantic/near scans did not establish that contract.
- The health explanation lists recursion among cognitive increments, but I did not confirm an explicit recursion increment in the v3.36.0 visitor. That detail is **unverified**; the source-backed definition above does not assume it. [Explanation](https://docs.fallow.tools/explanations/health/), [visitor](https://github.com/fallow-rs/fallow/blob/v3.36.0/crates/extract/src/complexity.rs)
- Whole-suite mutation runtime, equivalent-mutant triage, false-negative rates, and reliability compared with Stryker are **unverified**. The different score definitions prevent interpreting 84.26% versus 75.18% as improved test quality.
- Monetary Cloud pricing, private-repository SARIF entitlement in Routa's organization, and a live CI rollout were not tested. No paid/runtime add-on was exercised.

## Measurements

Probe: `git worktree add --detach /tmp/routa-quality-probe origin/stack/advanced-response-contracts/07-migrate-qualify` at `d7a3725`, `vp install --frozen-lockfile`, then `vp run build:packages`. Extra packages were installed into the probe only (`pnpm add -w -D … --ignore-workspace-root-check`); tracked manifests in this checkout were not touched. Timings are wall clock on a single Apple-silicon machine, uncontrolled.

### Coverage (v8, Vitest 5.0.5, unit tests only)

Command, per package directory:

```text
vp test run --coverage.enabled --coverage.provider=v8 \
  --coverage.include='src/**/*.ts' --coverage.exclude='**/*.test.ts' \
  --coverage.reporter=json-summary --coverage.reporter=text-summary
```

| Package                    | Tests | Statements         | Branches           | Functions        | Lines              |
| -------------------------- | ----- | ------------------ | ------------------ | ---------------- | ------------------ |
| `packages/core`            | 211   | 95.76% (610/637)   | 93.01% (546/587)   | 100% (138/138)   | 95.68% (599/626)   |
| `packages/cli`             | 367   | 88.29% (2648/2999) | 82.51% (2228/2700) | 91.93% (547/595) | 88.29% (2573/2914) |
| `packages/create-routa-ts` | 13    | 60.47% (127/210)   | 60.38% (93/154)    | 73.91% (34/46)   | 60.09% (125/208)   |

Hotspot files (statements / branches / functions / lines; uncovered branches in the last column):

| File                            | Statements | Branches          | Functions | Lines  | Uncovered branches |
| ------------------------------- | ---------- | ----------------- | --------- | ------ | ------------------ |
| `cli/src/contract-schemas.ts`   | 95.56%     | 89.90% (926/1030) | 99.41%    | 95.52% | 104                |
| `cli/src/project.ts`            | 80.10%     | 72.15% (500/693)  | 86.20%    | 80.23% | 193                |
| `cli/src/scaffold-plan.ts`      | 92.81%     | 86.77% (420/484)  | 94.44%    | 93.22% | 64                 |
| `cli/src/openapi.ts`            | 93.47%     | 83.53% (203/243)  | 98.48%    | 93.15% | 40                 |
| `core/src/request-execution.ts` | 91.76%     | 87.20% (184/211)  | 100%      | 91.59% | 27                 |
| `core/src/response-cookies.ts`  | 99.28%     | 96.38% (160/166)  | 100%      | 99.27% | 6                  |
| `core/src/response-headers.ts`  | 97.97%     | 95.23% (100/105)  | 100%      | 97.93% | 5                  |

Lowest branch coverage in `packages/cli`: `runtime.ts` 39.58% (19/48), `operation-id.ts` 50% (1/2), `typescript-runner.ts` 62.5% (5/8), `index.ts` 69.13% (56/81). In `create-routa-ts`: `cli.ts` 0%, `index.ts` 50.44% (57/113).

Run time for `packages/cli`: about 7.3 s with coverage and about 6.9 s without (three plain runs: 6.99, 6.98, 6.87 s). `packages/core` with coverage: 0.48 s.

### Complexity

Commands used a temp config passed with `-c` (for example `{"rules":{"complexity":["warn",{"max":10}]}}`) and `-f json` over `packages/core/src packages/cli/src packages/create-routa-ts/src`. Counts below are functions in non-test source with complexity above the threshold; the count of source functions with complexity of at least 2 is 460.

| Package           | > 10 | > 15 | > 20 |
| ----------------- | ---- | ---- | ---- |
| `core`            | 9    | 4    | 1    |
| `cli`             | 39   | 21   | 14   |
| `create-routa-ts` | 3    | 2    | 1    |
| Total             | 51   | 27   | 16   |

Test files: 2 functions above 10, 1 above 15, none above 20.

Hotspot files (functions above 10 / 15 / 20, maximum): `contract-schemas.ts` 18 / 10 / 6, max 44; `project.ts` 9 / 2 / 1, max 24; `scaffold-plan.ts` 7 / 6 / 5, max 41; `openapi.ts` 3 / 2 / 1, max 25; `request-execution.ts` 1 / 0 / 0, max 12.

Top 10 by Oxlint cyclomatic complexity (non-test):

| Complexity | Function                    | Location                                    |
| ---------- | --------------------------- | ------------------------------------------- |
| 44         | private method `factory`    | `packages/cli/src/contract-schemas.ts:1979` |
| 41         | `placeholderForSchema`      | `packages/cli/src/scaffold-plan.ts:1454`    |
| 38         | private method `method`     | `packages/cli/src/contract-schemas.ts:2075` |
| 32         | `cookieConfigProblem`       | `packages/core/src/response-cookies.ts:67`  |
| 31         | `evaluateScaffold`          | `packages/cli/src/scaffold-plan.ts:126`     |
| 30         | `zodForSchema`              | `packages/cli/src/scaffold-plan.ts:1283`    |
| 29         | private method `readCookie` | `packages/cli/src/contract-schemas.ts:1411` |
| 28         | private method `outcomes`   | `packages/cli/src/contract-schemas.ts:978`  |
| 28         | `validateSchema`            | `packages/cli/src/scaffold-plan.ts:911`     |
| 25         | `driftDiagnostics`          | `packages/cli/src/openapi.ts:463`           |

Cognitive complexity (`eslint-plugin-sonarjs@4.2.2`, threshold 15, via `jsPlugins`): 30 non-test functions over the limit (`core` 4, `cli` 25, `create-routa-ts` 1), none in tests. Top: `project.ts:1657` 46, `scaffold-plan.ts:456` 40, `contract-schemas.ts:2075` 39, `scaffold-plan.ts:1683` 37, `contract-schemas.ts:978` 35, `openapi.ts:463` 32, `scaffold-plan.ts:126` 30, `project.ts:1908` 30, `response-cookies.ts:67` 26 (core), `index.ts:59` 25 (cli).

Other native rules, counted in non-test source:

| Rule and setting                   | Source | Tests |
| ---------------------------------- | ------ | ----- |
| `max-depth` above 4                | 1      | 0     |
| `max-depth` above 3                | 18     | 0     |
| `max-nested-callbacks` above 3     | 0      | 3     |
| `max-lines-per-function` above 100 | 11     | 36    |
| `max-lines-per-function` above 200 | 1      | 11    |
| `max-params` above 5               | 2      | 0     |

### Strict TypeScript flags

Method: a temp `tsconfig.probe.json` per package with `"extends": "./tsconfig.json"` (source) or `"./tsconfig.test.json"` (source plus tests) and one flag added, run as `node_modules/.bin/tsc -p tsconfig.probe.json --noEmit`, errors counted by `error TS`. The baseline is 0 errors in every case. The test project includes source, so test-only errors are the test count minus the source count.

| Package           | Project        | `exactOptionalPropertyTypes` | `noUncheckedIndexedAccess` | `noImplicitOverride` | `noPropertyAccessFromIndexSignature` | All four |
| ----------------- | -------------- | ---------------------------- | -------------------------- | -------------------- | ------------------------------------ | -------- |
| `core`            | source         | 2                            | 1                          | 0                    | 11                                   | 14       |
| `core`            | source + tests | 7                            | 8                          | 0                    | 17                                   | 32       |
| `cli`             | source         | 13                           | 13                         | 0                    | 79                                   | 125      |
| `cli`             | source + tests | 16                           | 77                         | 0                    | 235                                  | 349      |
| `create-routa-ts` | source         | 0                            | 0                          | 0                    | 3                                    | 3        |
| `create-routa-ts` | source + tests | 0                            | 0                          | 0                    | 3                                    | 3        |

Source errors for `exactOptionalPropertyTypes` (15): `core/src/hono.ts:109`, `core/src/response-cookies.ts:156`; `cli/src/contract-schemas.ts` lines 529, 1603, 1725, 3312; `cli/src/index.ts:168`; `cli/src/project.ts` lines 1120, 1220, 1531; `cli/src/runtime.ts:35`; `cli/src/scaffold-plan.ts` lines 215, 226; `cli/src/scaffold.ts:163`; `cli/src/typescript-runner.ts:35`.

Source errors for `noUncheckedIndexedAccess` (14): `core/src/request-execution.ts:412`; `cli/src/contract-schemas.ts` lines 1987, 2349, 2350; `cli/src/openapi.ts:455`; `cli/src/project.ts` lines 1423, 2230, 2329, 2510; `cli/src/scaffold-plan.ts` lines 446, 1728, 1813, 1817 (two errors on 1817).

### Mutation pilot (StrykerJS 10.1.1)

Setup in the probe only: `@stryker-mutator/core@10.1.1`, `@stryker-mutator/vitest-runner@10.1.1`, `vitest@5.0.5`, and (for the checker attempts) `@stryker-mutator/typescript-checker@10.1.1`. Config files lived in `/tmp`; settings: `testRunner: "vitest"`, `coverageAnalysis: "perTest"`, `concurrency: 4`, `inPlace: true`, `ignorePatterns: ["dist", "coverage"]`. Run from the package directory with `node_modules/.bin/stryker run /tmp/<config>.json`.

| Run                                                                                               | Target                                                                               | Mutants | Result                                                                                                                                                   | Time                                          |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Default sandbox mode                                                                              | `core/src/response-cookies.ts`                                                       | 495     | Crashed: `ts.parseConfigFileTextToJson is not a function`                                                                                                | 1.2 s                                         |
| `inPlace`, no checker                                                                             | `core/src/response-cookies.ts` (442 physical lines at `d7a3725`; corrected from 337) | 495     | 321 killed, 102 survived, 4 no coverage, 68 runtime errors; score 75.18% (errors are outside the score); 14.1 tests per mutant; 201 tests in the dry run | 30 s (mutation phase 29 s)                    |
| `inPlace`, `--incremental`, second run                                                            | same                                                                                 | 495     | 495 of 495 reused                                                                                                                                        | 1.7 s                                         |
| `inPlace`, `--incremental`, after appending a comment to the file                                 | same                                                                                 | 495     | 495 of 495 reused                                                                                                                                        | 1.7 s                                         |
| TS checker on `typescript@7.0.2`                                                                  | `core` lines 60 to 110                                                               | n/a     | Initialization error (`fileExists`)                                                                                                                      | seconds                                       |
| `experimentalNativePreview` on `typescript@7.0.2`                                                 | same                                                                                 | n/a     | Initialization error (`readFile`)                                                                                                                        | seconds                                       |
| TS checker with `typescript@6.0.3` forced into the Stryker packages' resolution (probe-only hack) | `core/src/response-cookies.ts`                                                       | 495     | 226 killed, 81 survived, 3 no coverage, 185 errors; score 72.90%                                                                                         | 1 min 55 s                                    |
| `inPlace`, no checker                                                                             | `cli/src/ast.ts` (246 lines)                                                         | 127     | 111 killed, 10 timeout, 4 survived, 2 no coverage; score 95.28%                                                                                          | 2 min 49 s (dry run alone 15 s for 365 tests) |

Surviving mutants in `response-cookies.ts` by mutator: `ConditionalExpression` 44, `StringLiteral` 14, `Regex` 13, `LogicalOperator` 12, `EqualityOperator` 9, `BlockStatement` 5, `MethodExpression` 2, and one each of `ArrayDeclaration`, `ArrowFunction`, `ObjectLiteral`. Examples from the console report: a mutant replacing `typeof name !== "string"` with `false` survives at line 70; `maxAge < 0` changed to `maxAge <= 0` survives at line 98. These are specific, line-level gaps, and I did not check whether they are equivalent mutants. The 68 runtime errors in the unchecked run are mutants of module-level regexes that crash on import; Stryker excludes them from the score.

After the runs, `git status` in the probe showed the mutated source files restored.

### Property-based test pilot

One property in a throwaway test file (deleted afterward): for `fc.string({ unit: "binary", maxLength: 40 })`, `serializeCookieEffect` either throws or produces a field whose value decodes with `decodeURIComponent` back to the input and contains only RFC 6265 cookie octets, 2000 runs. It passed in 0.3 s under `vp test run`. I wrote it to test the toolchain, not to find a bug.

### Vitest typecheck pilot

Throwaway `src/zz-probe.test-d.ts`; `vp test run --typecheck.only`; deliberate mismatch reported as `TypeCheckError` with line and column, total 0.7 s.

### Package and API surface

- `attw` with the default profile: node10 `Resolution failed` and node16-from-CJS `ESM (dynamic import only)` for all entry points in all three packages. With `--profile esm-only`: exit 0, node16-from-ESM and bundler green. 0.2 to 0.5 s per package.
- `publint --strict`: `All good!` for all three packages.
- `api-extractor` 7.59.4 on `packages/core/dist/index.d.ts`: succeeded, 342-line report, about 0.5 s, warnings only (release tags, two TSDoc brace messages).

### Knip

`node_modules/.bin/knip --no-progress --reporter compact` at the root: 0.97 s. Package-restricted findings:

- Unused dependency: `packages/cli` `tsx`.
- Unused exports: `cli/src/ast.ts` `localInitializer`; `cli/src/contract-schemas.ts` `humanizeOutcomeName`; `cli/src/runtime.ts` `startRuntime`; `cli/src/typescript.ts` `createSourceFile`; `core/src/response-cookies.ts` `cookieConfigProblem`, `isCookieHandle`, `cookieIdentity`; `core/src/response-headers.ts` `declaredShape`.
- Unused exported types: `cli/src/contract-schemas.ts` `JsonSchema`, `ProjectedCookie`, `ProjectedHeader`; `cli/src/project.ts` `MiddlewareRejectMetadata`, `RouteDeprecationMetadata`; `cli/src/scaffold-plan.ts` `ManifestGeneratedFile`.

### fallow 3.36.0

Reused `/tmp/routa-fallow-probe`, detached at `d7a3725`. It initially had no `node_modules`; `fnm exec --using 24 -- vp install --frozen-lockfile` completed successfully. No fallow dependency, config, hook, skill, or tracked manifest was added. All invocations used `fnm exec --using 24 -- npx -y fallow@3 …`; the selected executable reported 3.36.0 and the mutation companion reported Node v24.18.0. Static runs used default config/cache behavior. Wall times include fnm/npx startup, exclude the initial package download/install, and are uncontrolled single-machine measurements. JSON field meanings follow the [versioned output schema](https://github.com/fallow-rs/fallow/blob/v3.36.0/docs/output-schema.json); the following numbers are observations from these commands, not upstream benchmarks.

| Arguments after `fallow@3`                                                                                         | Wall time | Exit | Result                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------ | --------- | ---- | --------------------------------------------------------------------------------------------------------------------------------- |
| `dead-code --format json --quiet`                                                                                  | 0.69 s    | 1    | 57 issues: 45 files, 7 exports, 2 runtime dependencies, 2 dev dependencies, 1 circular dependency                                 |
| `dead-code --workspace @routa-ts/core --workspace @routa-ts/cli --workspace create-routa-ts --format json --quiet` | 0.75 s    | 1    | 8 issues: 7 exports and the cycle; 0 unused files/types/dependencies                                                              |
| `health --format json --quiet`                                                                                     | 1.56 s    | 1    | 44.7/100, grade D, formula v3; 69 findings; 158 files and 2,043 functions/template units analyzed                                 |
| `dupes --format json --quiet`                                                                                      | 0.99 s    | 0    | 34 clone groups, 78 instances, 22 families; 1,510 duplicated lines out of 21,017 scanned lines, 7.18466%; 4,858 duplicated tokens |
| `dupes --mode semantic --near --format json --quiet`                                                               | 0.96 s    | 0    | 92 groups, 212 instances, 49 families; 2,976 duplicated lines, 14.15997%                                                          |
| `architecture --format json --quiet`                                                                               | 0.70 s    | 1    | Exactly 1 module cycle, the known `contract-schemas.ts` / `project.ts` value-import cycle                                         |
| `audit --base origin/main --format json --quiet`                                                                   | 1.46 s    | 1    | Fail; 110 changed files; 21 dead-code/graph issues, 59 complexity findings, 8 clone groups                                        |

**Dead code versus the recorded knip run.** Fallow's root counts versus knip's are files **45 vs 51**, exports **7 vs 8**, types **0 vs 6**, runtime dependencies **2 vs 11**, dev dependencies **2 vs 9**. Knip's totals include dependencies installed for its earlier pilots; this fallow probe has no such additions, so dependency totals are not an equal-install comparison. The note does not retain knip's full 51-file/dependency lists, so a complete root-level set difference is **unverified**. Fallow took 0.69 s versus knip's recorded 0.97 s, with uncontrolled caches/setup. [Dead-code reporting contract](https://docs.fallow.tools/analysis/dead-code/)

The package-only symbol comparison is exact against the lists recorded above:

| Comparison                                            | Findings                                                                                                                                                                                                                                                             |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Same, 7 exports                                       | `cli/src/ast.ts:localInitializer`; `cli/src/contract-schemas.ts:humanizeOutcomeName`; `cli/src/typescript.ts:createSourceFile`; `core/src/response-cookies.ts:cookieConfigProblem`, `isCookieHandle`, `cookieIdentity`; `core/src/response-headers.ts:declaredShape` |
| Knip-only, 1 export                                   | `cli/src/runtime.ts:startRuntime`                                                                                                                                                                                                                                    |
| Knip-only, 6 types                                    | `JsonSchema`, `ProjectedCookie`, `ProjectedHeader` in `contract-schemas.ts`; `MiddlewareRejectMetadata`, `RouteDeprecationMetadata` in `project.ts`; `ManifestGeneratedFile` in `scaffold-plan.ts`                                                                   |
| Knip-only, 1 dependency                               | `packages/cli:tsx`                                                                                                                                                                                                                                                   |
| Fallow-only relative to those listed package findings | The 2-file cycle; no additional package unused symbols/dependencies                                                                                                                                                                                                  |

Fallow's 45 file findings are 43 under examples and 2 scripts, `benchmark-tooling.mjs` and `check-tooling-cache.mjs`. Its runtime-dependency findings are `sharp` in each of `apps/design` and `apps/docs`; dev-dependency findings are root `yaml` and `@astrojs/compiler-rs`. These were not triaged. It detected 97 entry points, 21 from package metadata and 76 from plugins. It also hid 72 cascading unused-symbol findings inside dead files. Three `.routa/` skip diagnostics degraded the import graph; no `*.routa/routes.gen.ts` unused-file finding means those directories were skipped, not proven used. This is a difference from knip's generated-file findings, not evidence of better reachability. [Entry/cascade semantics](https://docs.fallow.tools/analysis/dead-code/), [output diagnostics](https://github.com/fallow-rs/fallow/blob/v3.36.0/docs/output-schema.json)

**Health.** The score penalties were dead files 5.7, dead exports 5.2, maintainability 3.8, hotspots 10.0, unused deps 12.7, cycles 3.2, unit size 10.0, coupling 2.5, duplication 2.2, and complexity/P90 0.0. Displayed rounded penalties sum to 55.3. The incomplete graph affects dead-code-derived inputs, so 44.7 is a zero-config result with known caveats. Its total complexity population includes tests, scripts, configurations, and template units; that denominator is broader than the earlier Oxlint source-only population. [Score definition](https://docs.fallow.tools/explanations/health/#health-score)

Top 10 emitted functions by cyclomatic complexity across the scan, with the earlier Oxlint package-source values where available:

| Fallow CC | Cognitive | Function               | Location                                    | Earlier Oxlint CC |
| --------- | --------- | ---------------------- | ------------------------------------------- | ----------------- |
| 44        | 26        | `factory`              | `packages/cli/src/contract-schemas.ts:1979` | 44                |
| 39        | 26        | `placeholderForSchema` | `packages/cli/src/scaffold-plan.ts:1454`    | 41                |
| 38        | 42        | `method`               | `packages/cli/src/contract-schemas.ts:2075` | 38                |
| 32        | 33        | `cookieConfigProblem`  | `packages/core/src/response-cookies.ts:67`  | 32                |
| 31        | 31        | `evaluateScaffold`     | `packages/cli/src/scaffold-plan.ts:126`     | 31                |
| 29        | 32        | `readCookie`           | `packages/cli/src/contract-schemas.ts:1411` | 29                |
| 29        | 27        | `zodForSchema`         | `packages/cli/src/scaffold-plan.ts:1283`    | 30                |
| 28        | 38        | `outcomes`             | `packages/cli/src/contract-schemas.ts:978`  | 28                |
| 27        | 30        | `validateSchema`       | `packages/cli/src/scaffold-plan.ts:911`     | 28                |
| 25        | 26        | `run`                  | `scripts/benchmark-tooling.mjs:169`         | Not measured      |

Filtering to package non-test source gives the first nine rows plus `create-routa-ts/src/index.ts:362:onKeypress` at CC 24, cognitive 12. Thus **9 of the earlier Oxlint top 10 functions recur**. Oxlint's tenth, `openapi.ts:463:driftDiagnostics`, scores 23 rather than 25 in fallow and drops out. Both count 16 package-source functions >20. At cognitive >15, fallow counts **33** (`cli` 27, `core` 5, create 1), versus sonarjs **30** (`cli` 25, `core` 4, create 1). Examples: `project.ts:1657` **48 vs 46**, `contract-schemas.ts:2075` **42 vs 39**, `openapi.ts:463` **38 vs 32**, and `response-cookies.ts:67` **33 vs 26**. These are implementation differences in the metrics, not changed Routa source. [Fallow visitor definitions](https://github.com/fallow-rs/fallow/blob/v3.36.0/crates/extract/src/complexity.rs)

Top 10 churn hotspots, default six-month history/minimum three commits:

| Rank | File                                            | Score | Commits | Trend        |
| ---- | ----------------------------------------------- | ----- | ------- | ------------ |
| 1    | `packages/cli/src/contract-schemas.ts`          | 85.2  | 29      | Stable       |
| 2    | `packages/cli/src/openapi.ts`                   | 50.4  | 22      | Stable       |
| 3    | `packages/cli/src/project.ts`                   | 47.7  | 24      | Accelerating |
| 4    | `packages/core/src/request-execution.ts`        | 22.8  | 10      | Accelerating |
| 5    | `packages/core/src/hono.ts`                     | 18.8  | 11      | Stable       |
| 6    | `packages/cli/src/scaffold-plan.ts`             | 17.9  | 7       | Accelerating |
| 7    | `packages/core/src/response-cookies.ts`         | 17.3  | 5       | Cooling      |
| 8    | `packages/cli/src/schema-contracts.test.ts`     | 14.3  | 14      | Cooling      |
| 9    | `packages/core/src/middleware-outcomes.test.ts` | 13.0  | 6       | Cooling      |
| 10   | `packages/cli/src/ast.ts`                       | 12.0  | 5       | Stable       |

There were 49 ranked files and 31 excluded below the minimum/history criteria; only 2 ranked scores met the >=50 score-penalty cutoff. The report marked history non-shallow and anchored recency to the HEAD commit, rather than the wall clock. [Hotspot contract](https://docs.fallow.tools/explanations/health/#hotspot-metrics), [source](https://github.com/fallow-rs/fallow/blob/v3.36.0/crates/engine/src/health/hotspots.rs)

**Duplication.** Selected large groups were mostly CSS/Astro shared by the temporary design app and public docs; the core/CLI group is included for comparison:

| Clone tokens / reported lines | Instances                                                                                          |
| ----------------------------- | -------------------------------------------------------------------------------------------------- |
| 652 / 165                     | `apps/design/src/styles/landings.css:231–395`; `apps/docs/src/styles/landing.css:243–405`          |
| 362 / 84                      | `apps/design/src/styles/landings.css:107–190`; `apps/docs/src/styles/landing.css:78–160`           |
| 322 / 32                      | `apps/design/src/pages/landings/schematic.astro:73–104`; `apps/docs/src/pages/index.astro:149–180` |
| 236 / 31                      | Same Astro files at `111–141` and `191–221`                                                        |
| 174 / 31                      | `packages/cli/src/contract-schemas.ts:2820–2850`; `packages/core/src/response-cookies.ts:16–46`    |

The final row contains the shared `isIsoDateTime` calendar/timezone checks and is the **only default clone group spanning core and CLI**. The semantic/near run added a 30-line overlapping group around the same function, not another cross-package rule family. It did not report core `types.ts` versus CLI header/cookie/name policy equivalence. Same-file CLI clones included `contract-schemas.ts:1445–1456` versus `1471–1482` (56 tokens/12 lines), the repeated required-attribute lookup in `readCookie`'s text/flag helpers. No output proves that all repeated transport rules were found. Tests are excluded from default duplication discovery, so its 21,017-line denominator differs from health's 55,781 total lines. [Clone modes and discovery](https://docs.fallow.tools/analysis/duplication/)

**Architecture and this stack's audit.** The cycle edges were `contract-schemas.ts:13` and `project.ts:25`. Boundary and rule-pack counts were zero because no policies were configured, with explicit diagnostics saying those detectors did not run. Audit compared `d7a3725` to local `origin/main`, reported 110 changed files, and failed in 1.46 s. Attribution: dead-code/graph **9 introduced / 12 inherited**; complexity **39 introduced / 20 inherited**, including **6 worsened** matched findings; clones **4 introduced / 4 inherited**, with **1 demoted** clone; styling 0. Thus the 39/20 split includes the six worsened findings within the inherited side. [Architecture model](https://docs.fallow.tools/analysis/boundaries/), [audit attribution](https://docs.fallow.tools/cli/audit/)

The nine introduced dead-code/graph findings were `examples/full-api/src/cookies.ts`, `examples/full-api/src/session.ts`, six exports (`localInitializer`, `humanizeOutcomeName`, `cookieConfigProblem`, `isCookieHandle`, `cookieIdentity`, `declaredShape`), and the cycle. The four introduced clone groups were the core/CLI date-time helper, `project.ts:1192` versus `1213`, `contract-schemas.ts:1445` versus `1471`, and two blocks in scaffold `$itemId/schemas.ts:18` versus `37`. Example unused-file findings retain the `.routa/` reachability caveat. The gate result is a measured output, not triage that all those findings are defects. [Audit gate semantics](https://docs.fallow.tools/cli/audit/)

**Mutation pilot on `packages/core/src/response-cookies.ts`.** The initial unchanged-install run failed in **0.67 s**, exit 2: `FALLOW_MUTATION_RUNNER_FAILED`, `runner-not-found: vitest is not installed in .../packages/core`. The loader resolves `vitest/package.json` and `vitest/node` directly from the project. To test the bundled runner without changing manifests, a probe-only `packages/core/node_modules/vitest` symlink pointed to the existing `vitest@5.0.5` directory resolved from `vite-plus/package.json`. No second Vitest was downloaded. This is a local compatibility shim; the normal dependency setup remains unverified. [Vitest resolution source](https://github.com/fallow-rs/fallow/blob/v3.36.0/crates/api/src/mutation/companion/adapters/vitest.mjs)

Command from the probe root, with output paths in the probe research directory:

```text
fnm exec --using 24 -- npx -y fallow@3 mutation src/response-cookies.ts \
  --root packages/core --allow-dirty --no-cache --time-budget 90s \
  --concurrency 4 --format json -o .fallow-research/mutation-cold.json
```

`--allow-dirty` allowed the untracked research reports. It did not disable the post-run worktree check. A complete uncached run reported no changed paths or errors. A prior execution gave the same mutant counts in 41.89 s but was marked partial because a concurrent research command wrote two report files; it is excluded from the clean timing. [Worktree and completion contract](https://github.com/fallow-rs/fallow/blob/v3.36.0/docs/mutation-testing.md)

| Run                              | Result                                                                                                                                                            | Wall time   |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| Uncached, no typecheck           | 346 total; 289 killed, 54 survived, 3 no coverage; 0 timeout/runtime error/flaky/pending/pruned; score **84.26%**, mutation coverage **99.13%**; complete, exit 0 | **40.93 s** |
| Cached repeat, no typecheck      | 343 cached tested results; same counts/score; complete, exit 0                                                                                                    | **1.72 s**  |
| Cached repeat with `--typecheck` | 54 survivors checked; **11 compile errors**, 43 survivors; 289 killed, 3 no coverage; score **87.05%**; complete, exit 0                                          | **2.92 s**  |

The clean uncached phases were planning 45 ms, setup 127 ms, dry run 913 ms, mutants 31,845 ms, and survivor retries 7,363 ms. The optional native survivor checker took 858 ms and completed without the TypeScript 7 API errors recorded for Stryker. The runtime was Vitest 5.0.5 under Node 24.18.0 with the repo still using TypeScript 7.0.2. Fallow's companion manifest pins that TS version. [Native companion](https://github.com/fallow-rs/fallow/blob/v3.36.0/tools/type-aware-sidecar/package.json), [survivor check](https://github.com/fallow-rs/fallow/blob/v3.36.0/docs/mutation-testing.md)

Compared with the prior Stryker pilot, this is **346 vs 495 mutants**, **40.93 vs 30 s** uncached, and **84.26% vs 75.18%** without typechecking. Fallow had 0 runtime errors versus Stryker's 68; the operator sets differ, including regex mutation rules. Fallow's three uncovered mutants are outside its score, whereas Stryker's four lower its recorded score. These runs cannot rank test strength or tool accuracy. Stryker's cached repeat was 1.7 s versus fallow's 1.72 s. The original note's 337-line label was inaccurate for this commit: the source has 442 newline-terminated physical lines; the earlier Stryker counts/timings were retained rather than rerun. [Fallow scoring](https://github.com/fallow-rs/fallow/blob/v3.36.0/docs/mutation-testing.md#score-and-coverage), [Routa source at the measured commit](https://github.com/Routa-ts/Routa/blob/d7a3725/packages/core/src/response-cookies.ts)

### Locale dependence of `localeCompare`

```text
for l in en_US.UTF-8 sv_SE.UTF-8 tr_TR.UTF-8 C; do
  LC_ALL=$l LANG=$l node -e 'console.log(JSON.stringify(["z","ä","a","I","ı","i"].sort((a,b)=>a.localeCompare(b))))'
done
en_US.UTF-8: ["a","ä","i","I","ı","z"]
sv_SE.UTF-8: ["a","i","I","ı","z","ä"]
tr_TR.UTF-8: ["a","ä","ı","I","i","z"]
C:           ["a","ä","i","I","ı","z"]
```

Node 24.18.0 on macOS. The result depends on the ICU build and environment of whichever machine runs the generator. I did not test Linux CI images.

## Open questions and unverified items

- **Stryker and Vitest 5.** The docs name no supported Vitest versions. Evidence for 5.0.5 is one successful pilot on two files plus a Vitest-5 branch in the runner source. I did not run Stryker across the whole suite.
- **Stryker and TypeScript 7.** The classic checker and the sandbox-mode tsconfig step both need the TypeScript JS API, which 7.0 does not ship. A working setup needed a probe-only symlink hack. Whether a supported side-by-side install (`@typescript/typescript6` or an alias) fits this repository's `typescript@7.0.2` direct dependency and the CLI's `typescript/unstable/*` imports is untested. The `experimentalNativePreview` failure cause is inferred from source, not traced.
- **Stryker CI shape.** The docs do not say how to persist the incremental file across CI runs, and I found no changed-files option. Whole-repository runtime is not measured. The pilots recorded 495 mutants for `response-cookies.ts` (442 physical lines at the stated commit, correcting the original 337-line label) and 127 for the 246-line `ast.ts`. A rough size-based extrapolation to `contract-schemas.ts` (3,318 lines) and `project.ts` (3,223 lines) suggests several thousand mutants each, running against the CLI suite whose dry run alone took 15 s under Stryker. That extrapolation is mine and unmeasured; operator density and filtering also affect mutant counts.
- **Duplicate Vitest copies.** Adding root-level `vitest` and `@vitest/coverage-v8` produced several `vitest@5.0.5` directories in the pnpm store. I did not determine whether this breaks anything, or whether the `vitest@*` override in the Vite Plus guide would be needed in this repository.
- **fast-check.** The default `numRuns` and the seed message format were not confirmed from the docs pages I could fetch. A Zod-schema generator for the oracle comparison does not exist in the libraries I checked; I did not search the fast-check ecosystem for one.
- **Complexity and defects.** I found no primary evidence that complexity thresholds reduce defects in TypeScript libraries. The cited studies cover method-size correlation (Java) and understandability.
- **Oxlint.** `jsPlugins` is documented as alpha. I did not time lint runs with `sonarjs` loaded. I did not confirm whether `oxlint --type-check` (tsgolint) honors the strict flags the same way `tsc` does.
- **Vitest typecheck.** Documented as experimental, with no tsgo mention. It worked with the TypeScript 7.0.2 `tsc` on one small file. A project-wide move from `@ts-expect-error` is unmeasured. The `testing-types` guide page timed out, so `expectTypeOf` details rest on the probe.
- **API Extractor.** Multi-entry-point support and its CI "report changed" behavior were not confirmed from fetched docs. It analyzes declarations with its bundled TypeScript 5.9.3, which parsed tsgo output for `@routa-ts/core`'s main entry point without error; subpath entries and the CLI package were not tried.
- **Knip.** The `tsx` and export findings were not triaged. Examples and generated route files need configuration; I did not write one.
- **Coverage.** Numbers cover package unit tests only, not the golden, pack, scaffold-smoke, or example layers. `coverage.changed` was run once and returned 0/0 because the last commit changed no source file. Its CI value is documented, not measured. I did not run the istanbul provider.
- **CodeQL.** Query suites and cost were not confirmed from the page I fetched.
- **`localeCompare`.** The eight remaining uses at this commit were counted, not classified, and the defect described in the brief may already be fixed elsewhere.
- **Timezone determinism.** My one attempt to show a `TZ`-dependent result returned the same value for two zones, so I report nothing on timezones.
