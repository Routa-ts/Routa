# Domain Docs

How engineering skills consume Routa's domain documentation.

## Before exploring

Read:

1. `CONTEXT.md` for canonical Routa vocabulary.
2. Relevant accepted decisions under `docs/adr/`.
3. The source hierarchy below for the area being changed.

If `CONTEXT.md` or `docs/adr/` does not exist, proceed silently. `/domain-modeling` creates them only when a term or durable decision is ready to record.

## Source hierarchy

### Shipped behavior

The implementation and tests define what the current packages do. Public documentation under `apps/docs/src/content/docs/docs/` explains that behavior for users.

`apps/docs/src/content/docs/docs/start/v0-scope.mdx` is the authoritative status boundary between implemented and deferred behavior.

If public documentation conflicts with code or tests, report documentation drift instead of silently selecting one version.

### Acceptance contracts

`docs/specs/v0/` contains acceptance contracts for current v0 behavior. A conflict between implementation and a v0 spec must be surfaced and resolved intentionally.

### Future direction

`docs/specs/v1/` and the design documents directly under `docs/` contain future direction and historical design work. They are not evidence that a feature currently exists.

Do not copy a v1 or design-document decision into `CONTEXT.md` or an accepted ADR unless current public behavior and implementation confirm it.

### Documentation authoring

When editing public documentation, follow `apps/docs/AGENTS.md`.

## File structure

This repository uses a single domain context:

```text
/
├── CONTEXT.md
└── docs/
    └── adr/
        ├── 0001-source-route-contracts.md
        ├── 0002-own-only-the-http-boundary.md
        └── 0003-commit-generated-routa-state.md
```

## Use the glossary vocabulary

Use terms from `CONTEXT.md` consistently in issue titles, specifications, tests, refactoring proposals, and documentation.

If a needed concept is missing, either reconsider the new terminology or use `/domain-modeling` to resolve the gap.

## Flag ADR conflicts

Surface contradictions rather than silently overriding an accepted decision:

> Contradicts ADR-0002 (Routa owns only the HTTP boundary), but may be worth reopening because...
