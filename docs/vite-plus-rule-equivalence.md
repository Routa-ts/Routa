# Biome to Oxc coverage decisions

This maps every explicitly configured rule in the former root `biome.json` at
`6bc9772` to the framework-development configuration in `vite.config.ts`.
Generated projects retain their own Biome configuration. Recommended presets are
different; this is an explicit-rule audit, not a claim that all preset rules or
diagnostic semantics are equivalent.

## Explicit rules

| Biome rule and old level                          | Oxc replacement and current level                                | Limits or decision                                                                                                                                                                                                        |
| ------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `noInvalidUseBeforeDeclaration`, error            | Compiler diagnostics in `vp lint` and explicit TypeScript checks | Partial: compiler checks invalid lexical uses, not the same lint semantics. Oxlint's broader `no-use-before-define` is deliberately off because hoisted functions and forward type references are valid in this codebase. |
| `noUndeclaredDependencies`, error                 | `dependency-checks/no-extraneous-dependencies`, error            | Runtime package source only, excluding tests. Plugin semantics differ from Biome; packed consumer checks remain required.                                                                                                 |
| `noUnusedImports`, error                          | `no-unused-vars`, error                                          | Includes import bindings; no automatic import removal on a check.                                                                                                                                                         |
| `noUnusedVariables`, error                        | `no-unused-vars`, error                                          | Naming and type-only-use semantics differ.                                                                                                                                                                                |
| `useImportExtensions`, off                        | No extension lint rule enabled                                   | Preserve TypeScript/ESM build handling.                                                                                                                                                                                   |
| `useJsonImportAttributes`, off                    | No matching lint rule enabled                                    | Preserve compiler/runtime checks.                                                                                                                                                                                         |
| `noConsole`, warn                                 | `no-console`, warn                                               | Tests exempt; same intentional console usage remains advisory.                                                                                                                                                            |
| `noDebugger`, error                               | `no-debugger`, error                                             | Explicitly enabled.                                                                                                                                                                                                       |
| `noExplicitAny`, off                              | `typescript/no-explicit-any` off                                 | No new ban on explicit `any`.                                                                                                                                                                                             |
| `noFocusedTests`, error                           | `vitest/no-focused-tests`, error                                 | Recognizes bundled `vite-plus/test`.                                                                                                                                                                                      |
| `noSkippedTests`, error                           | `vitest/no-disabled-tests`, error                                | Test runner semantics differ; focused/skipped checks are explicit.                                                                                                                                                        |
| `noTsIgnore`, error                               | `typescript/ban-ts-comment`, error                               | Rejects `ts-ignore` and `ts-nocheck`; allows intentional `ts-expect-error`, whose use is compiler-checked.                                                                                                                |
| `useAwait`, warn                                  | `typescript/require-await`, warn                                 | Type-aware: allows returning a promise without `await`; not identical to Biome's syntax rule.                                                                                                                             |
| `noDefaultExport`, off                            | No default-export ban                                            | Vite/Astro configuration uses default exports.                                                                                                                                                                            |
| `noInferrableTypes`, off                          | No inferrable-type restriction enabled                           | No added style restriction.                                                                                                                                                                                               |
| `noMagicNumbers`, off                             | No magic-number restriction enabled                              | No added style restriction.                                                                                                                                                                                               |
| `useExportType`, warn                             | `typescript/consistent-type-exports`, warn                       | Type-aware counterpart.                                                                                                                                                                                                   |
| `useImportType`, error                            | `typescript/consistent-type-imports`, error                      | Inline type import fixes.                                                                                                                                                                                                 |
| `useNodejsImportProtocol`, error                  | `unicorn/prefer-node-protocol`, error                            | Explicitly enabled.                                                                                                                                                                                                       |
| `useTemplate`, warn                               | `prefer-template`, warn                                          | Explicitly enabled; fix semantics differ.                                                                                                                                                                                 |
| `noBannedTypes`, error                            | `typescript/no-wrapper-object-types`, error                      | Partial: primitive wrappers are rejected; Biome's bans on broad `Function` and `{}` types are not reproduced. The framework deliberately uses structurally empty extension contracts.                                     |
| `noUselessConstructor`, error                     | `no-useless-constructor`, error                                  | Explicitly enabled.                                                                                                                                                                                                       |
| `useOptionalChain`, warn                          | `typescript/prefer-optional-chain`, warn                         | Type-aware counterpart; may select different safe rewrites.                                                                                                                                                               |
| `noBlankTarget`, error                            | No equivalent enabled                                            | Gap: no JSX rule/plugin added for a repository with no JSX components. Astro template safety is not covered by script lint; Astro checks/builds do not establish this rule's equivalence.                                 |
| `noGlobalEval`, error                             | `no-eval`, error                                                 | Explicitly enabled.                                                                                                                                                                                                       |
| `noSecrets`, error                                | `no-secrets/no-secrets`, error                                   | JavaScript plugin with tolerance 4.5; heuristics differ. Tests exempt.                                                                                                                                                    |
| `noAccumulatingSpread`, warn                      | `oxc/no-accumulating-spread`, warn                               | Explicitly enabled.                                                                                                                                                                                                       |
| Test override `noExcessiveNestedTestSuites`, warn | No nesting-limit rule enabled                                    | Gap retained: test structure is reviewed rather than constrained by a new depth threshold.                                                                                                                                |

Oxlint's bundled defaults add advisory rules beyond this list. The migration also
adds error-level unhandled/misused promise checks and experimental compiler
diagnostics. Explicit TypeScript source/test programs and Astro checks remain
required; replacing Biome did not make all script, template, CSS, or security
checks equivalent.

## Formatting and imports

Oxfmt formats the repository, while committed `.routa` metadata and the pristine
`examples/full-api/scaffold/src` regeneration fixture are excluded. The latter's
manifest hashes are checked by `vp run generated:check`; application-owned edits
in other examples are intentionally allowed.

Import organization is deliberately disabled with `sortImports: false`.
The old Biome check organized imports; that automatic organization is not carried
over. Preserving authored order avoids silently reordering initialization imports
during a tooling migration. Contributors can edit imports explicitly; unused
bindings still fail lint. Oxfmt's sorting is optional and disabled by default.
[Oxfmt sorting](https://oxc.rs/docs/guide/usage/formatter/sorting),
[Oxlint rule reference](https://oxc.rs/docs/guide/usage/linter/rules).

## Evidence and reproducibility

Tooling logs live in gitignored `.artifacts/tooling/`, separate from Dex task
state. They are local outputs, not portable links or committed evidence. The
tracked benchmark JSON and self-contained HTML contain commands, inputs, outcomes,
individual samples, and aggregate numbers. Rerun the documented harness to
recreate logs. Historical measurements keep their original numbers; configuration
changes are labelled rather than presented as fresh measurements.
