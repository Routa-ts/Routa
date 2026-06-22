# v0 Spec: Regeneration

## Feature

Trail regenerates source from changed OpenAPI through a stateful diff, not blind overwrite.

## Flow

```txt
current baseline
+ forward OpenAPI input
-> diff
-> preview affected files
-> warn on overwrite/conflict
-> user confirms or aborts
-> apply accepted changes
-> update manifest
-> optionally update baseline
```

## Acceptance Cases

```yaml
case: v0_regen_adds_new_route
intent: new OpenAPI path creates new generated files
input:
  baseline:
    paths:
      /users:
        get:
          operationId: listUsers
  forward:
    paths:
      /users:
        get:
          operationId: listUsers
      /users/{id}:
        get:
          operationId: getUserById
action: trail scaffold openapi.yaml
expected:
  preview:
    creates:
      - routes/users/$id/route.ts
      - routes/users/$id/schemas.ts
    modifies:
      - .trail/manifest.json
  behavior:
    - user can confirm or abort
    - user-owned application files are preserved
must_not:
  - regenerate full project from scratch
```

```yaml
case: v0_regen_modifies_generated_schema
intent: schema changes update managed schema files after preview
input:
  manifest:
    generated:
      - path: routes/users/schemas.ts
        kind: schemas
  change:
    User.email becomes required
action: trail scaffold openapi.yaml
expected:
  preview:
    modifies:
      - routes/users/schemas.ts
  behavior:
    - diff shows schema change
    - user confirms before write
```

```yaml
case: v0_regen_detects_manual_generated_file_edit
intent: manual edits in generated files are not silently lost
input:
  file:
    path: routes/users/route.ts
    tracked_in_manifest: true
    has_manual_edit: true
action: trail scaffold openapi.yaml
expected:
  behavior:
    - command detects file differs from expected generated state where possible
    - preview flags conflict
    - command stops unless user explicitly chooses conflict path
must_not:
  - silently overwrite manual edits
```

```yaml
case: v0_regen_removes_route_conservatively
intent: removed OpenAPI path does not delete source silently
input:
  baseline:
    paths:
      /users/{id}: get
  forward:
    paths:
      /users: get
action: trail scaffold openapi.yaml
expected:
  behavior:
    - preview reports route removed from OpenAPI
    - generated route file deletion requires explicit confirmation
    - user-owned application files remain untouched
must_not:
  - delete route files without confirmation
```

## Conflict Policy

- Stop on conflicts by default.
- Show file path, reason, and suggested resolution.
- Never delete user-owned files silently.
- Never overwrite files not tracked in manifest unless user explicitly accepts.

## Out of Scope

- Semantic merge of arbitrary user code.
- Automatic migration of application business logic.
