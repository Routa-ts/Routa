# Issue Tracker: Local Dex

Persistent issues, specifications, decision maps, and implementation tickets for this repository live in project-local Dex storage under `.dex/`.

`.dex/` is local working state. It is gitignored and must not be synchronized to GitHub or Shortcut.

## Boundaries

- Do not call `dex sync`, `dex import`, or `dex export`.
- Do not enable GitHub or Shortcut synchronization.
- Do not put Dex task IDs in commits, pull requests, release notes, or permanent documentation.
- Keep permanent product decisions in `CONTEXT.md` or `docs/adr/`, not only in Dex.
- Use in-session task tools for temporary scratch planning; use Dex when work must survive the session.

## Task descriptions

Descriptions should preserve enough context for a fresh agent session:

```markdown
Category: bug | enhancement
Triage: needs-triage | needs-info | ready-for-agent | ready-for-human | wontfix

## Context

Why this work exists and what has already been decided.

## What to deliver

The externally visible result.

## Acceptance criteria

- [ ] Observable criterion
- [ ] Verification criterion
```

Omit `Category` and `Triage` only for internal wayfinding tasks whose type and lifecycle are recorded separately.

Dex has no native label system. The `Category:` and `Triage:` lines are the tracker representation of Matt's category and state roles.

## Core operations

- Create: `dex create "<title>" --description "<description>"`
- Create a child: `dex create "<title>" --parent <parent-id> --description "<description>"`
- Add blockers: `dex create "<title>" --blocked-by <id>,<id>` or `dex edit <id> --add-blocker <id>,<id>`
- List the frontier: `dex list --ready`
- List blocked work: `dex list --blocked`
- Read full context: `dex show <id> --full`
- Claim work: `dex start <id>`
- Update context: `dex edit <id> --description "<complete updated description>"`
- Complete code work: `dex complete <id> --result "<verified result>" --commit <sha>`
- Complete non-code work: `dex complete <id> --result "<verified result>" --no-commit`

Preserve the entire existing description when editing it. Dex does not provide a separate comment stream.

Do not delete tasks unless the user explicitly asks. Use completion with a clear result when work is finished or rejected.

## When a skill publishes a specification

Create one top-level Dex task whose description contains the complete specification and:

```markdown
Category: enhancement
Triage: ready-for-agent
```

Use that task as the parent for tickets produced later by `/to-tickets`.

## When a skill publishes implementation tickets

Create approved tracer-bullet tickets in dependency order:

1. Create one Dex child task per ticket under the specification task when one exists.
2. Put the complete acceptance criteria in each description.
3. Set `Triage: ready-for-agent`.
4. Create or add native Dex blocking edges with `--blocked-by` or `--add-blocker`.
5. Work only tasks returned by `dex list --ready` whose description also says `Triage: ready-for-agent`.

If no specification task exists, create top-level tasks instead.

## When a skill fetches a ticket

Run:

```sh
dex show <id> --full
```

Use `--json` when structured output is useful.

## Triage operations

- Discover a role with `dex list "<role>" --json`, searching the `Triage:` marker.
- Change state by rewriting the description with the new `Triage:` value.
- Claim `ready-for-agent` work with `dex start <id>`.
- Record `wontfix` by setting `Triage: wontfix`, then completing with `--no-commit` and a clear explanation.
- Summarize any external conversation in the task description; local Dex has no reporter or comment surface.

## Wayfinding operations

A wayfinding map is a top-level Dex task. Decision tickets are its children.

The map description contains:

```markdown
Type: wayfinder:map

## Destination

## Notes

## Decisions so far

## Not yet specified

## Out of scope
```

Each child description begins with one type:

```markdown
Type: wayfinder:research
Type: wayfinder:prototype
Type: wayfinder:grilling
Type: wayfinder:task
```

- Create all currently visible children first, then add blocker edges.
- The frontier is the map's pending children returned by `dex list --ready`.
- Claim a child with `dex start <id>` before doing work.
- Resolve it with a detailed `dex complete` result.
- Append a one-line gist containing the child title to the map's `Decisions so far`.
- Keep unresolved questions under `Not yet specified` until they are precise enough to become children.
