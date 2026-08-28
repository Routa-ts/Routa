# Routa

Routa is a schema-first, OpenAPI-aware REST framework for TypeScript APIs. It should settle the HTTP boundary once, through typed route contracts, so developers can get back to application behavior. Routa owns routing, validation, middleware context, response serialization, diagnostics, and OpenAPI.

The application still owns its services, domain models, persistence, authentication, authorization, and business architecture. Hold that line. When normal application code must understand Routa internals or repeat transport logic, treat the leak as a framework design problem.

## A note from JC Aceves

I like ambitious ideas, simple systems, and software that feels obvious. Do not preserve complexity just because it already exists. Do not introduce machinery because it looks architecturally impressive. Understand the real constraint, then fight for the smallest model that makes the correct behavior unsurprising.

Channel both "measure twice, cut once" and "yagni". Fight scope creep. Try to honor the dev's intent in both a minimal and realistic fashion.

The rest of this document is meant to help you navigate the codebase and make changes effectively. Think of these instructions less as "hard rules", more as "good defaults". The developer's preferences should be able to override anything here.

## What makes Routa special

These are the qualities that make Routa worth using. Use them to judge every change. Improve the framework without trading any of them away.

### Application code stays about the application

Developer focus is the test. A route handler should express application decisions. It should not parse requests by hand, choose transport details, serialize responses, or keep OpenAPI synchronized. When every handler repeats the same transport work, Routa should own that translation.

### Types catch mistakes before users do

Types connect route input, middleware context, named outcomes, and handlers. Static checks cover the route graph, configuration, generated metadata, and OpenAPI before code ships.

Type inference and `routa check` are product guarantees. A feature is not complete while its types, checks, runtime behavior, generated metadata, and OpenAPI disagree. Prefer one clear build-time diagnostic over a late runtime failure or a rule buried in documentation.

### The source explains itself

An agent should understand a Routa project by reading `routa.ts`, route files, schemas, middleware contracts, generated metadata, and public documentation.

Keep behavior explicit. Use stable vocabulary, predictable files, deterministic generation, specific diagnostic codes, and complete runnable examples. Hidden registration, runtime mutation, and undocumented conventions force agents to guess. Treat that guesswork as a design flaw.

## How to work here

### Read the authority before choosing a direction

This repository has one domain context. Read `CONTEXT.md`, the relevant accepted ADRs under `docs/adr/`, and the source hierarchy in `docs/agents/domain.md` before changing domain behavior or making claims about what Routa supports.

When sources conflict, follow the documented authority order and say what conflicted. Do not quietly choose the source that makes the work easier.

### Keep persistent work in Dex

Project-local Dex under `.dex/` holds work that must survive the session. It is local, gitignored state. Keep it out of GitHub and external trackers.

Read `docs/agents/issue-tracker.md` before creating, changing, or completing Dex work. Dex task descriptions use the five canonical triage roles defined in `docs/agents/triage-labels.md`.

### Build the smallest complete contract

- Prefer a narrow promise that works through every affected layer over broad partial behavior.
- Keep one schema-backed contract when parallel registries or annotations could drift.
- Make failures early, specific, and actionable.
- Keep generated code readable, deterministic, and safe to edit.
- Implement with vertical tracer bullets. Make one capability usable before adding breadth.
- For a consequential design decision, present one bounded recommendation. Build a disposable preview when code or prose hides the tradeoff. Record the decision after approval.
- If a task requires breaking an accepted Routa boundary, say so loudly and get a human sign-off before breaking it.

## Pull requests should arrive ready

A pull request is for review, not a placeholder.

- Create a pull request only when the user explicitly asks.
- Open every pull request ready for review. Never create a draft.
- Preserve the current branch scope unless the user asks to split it.
- Before opening a PR, follow `CONTRIBUTING.md` and run `pnpm verify`. Add a changeset when publishable package behavior changes.
- Use a plain, imperative title. In the body, explain the problem, the change, verification, and the documentation or changeset decision.
- Keep Dex task IDs out of commits, PRs, release notes, and permanent documentation.
- Show evidence that the change works as expected. Report relevant tests, checks, or observed behavior for non-visual changes. Show a preview or before-and-after comparison for visual documentation and design changes.
- Treat every review comment as a claim. Check its correctness, importance, scope, and compatibility with accepted decisions before changing code.
- Fix valid, important findings. Reply with the change, then resolve the thread.
- Reply with a specific reason before resolving a finding that is wrong, already addressed, outside the PR scope, or in conflict with repository authority.
- Review work ends when every actionable finding is addressed and no unexplained unresolved thread remains.
- Merge only when explicitly asked. After a GitHub merge, refresh the local branch and verify the resulting state.

## Where code lives

- `packages/core/` owns public route and middleware contracts, type inference, the Hono runtime adapter, and framework logging.
- `packages/cli/` owns project and route-graph analysis, TypeScript parsing, generation, OpenAPI checks, scaffolding, diagnostics, and CLI commands.
- `packages/create-routa-ts/` creates Routa projects.
- `examples/basic-api/` proves the smallest executable consumer.
- `examples/full-api/` proves broader framework behavior and integration patterns.
- `apps/docs/` is the public documentation site. Follow its own `AGENTS.md` when working there.
- `apps/design/` is a temporary visual design lab. Keep it separate from public docs. It should disappear once the framework and visual design settle, so do not make it permanent product architecture.
- `docs/` holds accepted ADRs, agent instructions, and historical or future design material. Use `docs/agents/domain.md` to decide what carries authority.
- `scripts/` holds build, generation, smoke-test, and package verification helpers.
- `.dex/` holds local planning state. It is gitignored and does not belong in GitHub artifacts.

Make source changes under `src/` and rebuild generated outputs through repository scripts.

## Scoped instructions

When working under `apps/docs/`, follow `apps/docs/AGENTS.md`.
