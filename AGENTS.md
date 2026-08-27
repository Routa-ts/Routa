# Routa

Routa is a schema-first, OpenAPI-aware REST framework for TypeScript APIs. Developers describe the HTTP boundary through typed route contracts, then focus on application behavior. Routa handles routing, validation, middleware context, response serialization, diagnostics, and OpenAPI.

Applications keep ownership of services, domain models, persistence, authentication, authorization, and business architecture.

## What makes Routa special

### Focus on the application

Routa handles the HTTP mechanics so developers can spend their time on application behavior. Route handlers should express application decisions instead of manually parsing requests, selecting status codes, serializing responses, or keeping OpenAPI synchronized.

When normal application code must understand Routa internals or repeat transport logic, treat that as a framework design problem.

### Fully typed and checked before shipping

Types connect route input, middleware context, named outcomes, and handlers. Static checks validate the route graph, configuration, generated metadata, and OpenAPI before code reaches production.

Type inference and `routa check` are product guarantees. Preserve them across every feature. Prefer a clear build-time diagnostic over a runtime failure or a rule that exists only in documentation.

### Agent-friendly by design

An agent should understand a Routa project by reading `routa.ts`, route files, schemas, middleware contracts, generated metadata, and public documentation.

Keep behavior explicit in source. Use stable vocabulary, predictable file conventions, deterministic generation, specific diagnostic codes, and complete runnable examples. An agent should not need to reconstruct the framework from hidden registration, runtime mutation, or undocumented conventions.

## Agent skills

### Issue tracker

Persistent work is tracked in project-local Dex under the gitignored `.dex/` directory, with no external synchronization. See `docs/agents/issue-tracker.md`.

### Triage labels

Dex task descriptions use the five canonical triage roles. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository: read `CONTEXT.md`, relevant ADRs under `docs/adr/`, and the documentation precedence rules in `docs/agents/domain.md`.

## Pull requests

- Create a pull request only when the user explicitly asks.
- Every pull request must be ready for review when created. Never create a draft PR.
- Preserve the current branch scope unless the user asks to split it.
- Before opening a PR, follow `CONTRIBUTING.md` and run `pnpm verify`. Add a changeset when publishable package behavior changes.
- Use a plain, imperative title. Explain the problem, the change, verification, and any documentation or changeset decision in the body.
- Keep Dex task IDs out of commits, PRs, release notes, and permanent documentation.
- Visual documentation and design changes require a preview or before-and-after evidence in the PR.
- Treat each review comment as a claim to evaluate, not an instruction to apply automatically. Check its correctness, importance, scope, and compatibility with accepted decisions.
- Fix important and valid findings. Reply with the change and resolve the thread.
- Close or ignore findings that are incorrect, already addressed, outside the PR scope, or in conflict with repository authority. Always reply with the specific reason before resolving or closing them.
- Review work is complete only when every actionable finding is addressed and no unexplained unresolved threads remain.
- Merge only when explicitly asked. After a GitHub merge, refresh the local branch and verify the resulting state.

## Where code lives

- `packages/core/` contains public route and middleware contracts, type inference, the Hono runtime adapter, and framework logging.
- `packages/cli/` contains project and route-graph analysis, TypeScript parsing, generation, OpenAPI checks, scaffolding, diagnostics, and CLI commands.
- `packages/create-routa-ts/` creates new Routa projects.
- `examples/basic-api/` is the smallest executable consumer example.
- `examples/full-api/` proves broader framework behavior and integration patterns.
- `apps/docs/` is the public documentation site and has its own `AGENTS.md`.
- `apps/design/` is the temporary visual design lab. Keep it separate from the public documentation site. It is expected to be deleted once the framework and visual design are stable, so do not turn it into permanent product architecture.
- `docs/` contains accepted ADRs, agent instructions, and historical or future design material. Follow `docs/agents/domain.md` before treating a document as authoritative.
- `scripts/` contains repository build, generation, smoke-test, and package verification helpers.
- `.dex/` contains local persistent planning state. It is gitignored and does not belong in GitHub artifacts.

Make source changes under `src/` and rebuild generated outputs through repository scripts.

## Taste

- Developer focus is the test. Normal application code should describe application behavior, while Routa handles HTTP translation.
- Build the smallest complete contract. Broad partial behavior is worse than a narrow promise that works through every affected layer.
- Static guarantees are part of the feature. Keep types, checks, runtime behavior, generated metadata, and OpenAPI aligned.
- Explicit beats clever. Prefer one schema-backed contract over parallel registries or annotations that can drift. If an agent must execute the framework or inspect internals to understand a route contract, the design is too implicit.
- Make errors early, specific, and actionable.
- Keep generated code readable, deterministic, and safe to edit.
- Use vertical tracer bullets for implementation. Make a capability usable before adding the next layer of breadth.
- For consequential design work, present one bounded recommendation. Make a disposable preview when code or prose does not expose the tradeoff. Record the decision only after approval.
- When repository sources conflict, follow the documented authority order and state the conflict instead of silently choosing.
- If a task requires breaking an accepted Routa boundary, identify the boundary and get approval first.

## Scoped instructions

When working under `apps/docs/`, follow `apps/docs/AGENTS.md`.
