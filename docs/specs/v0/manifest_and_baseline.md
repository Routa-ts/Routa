# v0 Spec: Manifest and Baseline

## Feature

Routa tracks generated files and OpenAPI state with committed metadata.

## Files

```txt
.routa/manifest.json
.routa/openapi-baseline.json
.routa/routes.gen.ts
```

These files should be committed to git.

Routa-generated `.gitignore` defaults must not ignore them.

## Acceptance Cases

```yaml
case: v0_manifest_created_on_scaffold
intent: generated ownership is machine-detectable
input:
  command: routa scaffold openapi.yaml
action: scaffold project
expected:
  files:
    - .routa/manifest.json
  behavior:
    - manifest contains version
    - manifest contains OpenAPI baseline path
    - manifest tracks generated route files
    - manifest tracks generated schema files
    - manifest tracks generated route metadata file
    - manifest does not mark application business logic files as Routa-managed by default
must_not:
  - rely only on generated file comments for ownership
```

```yaml
case: v0_baseline_created_on_scaffold
intent: baseline captures current OpenAPI state
input:
  command: routa scaffold openapi.yaml
action: scaffold project
expected:
  files:
    - .routa/openapi-baseline.json
  behavior:
    - baseline stores normalized OpenAPI state
    - baseline can be used for future diff and breaking checks
    - generated .gitignore does not ignore baseline
```

```yaml
case: v0_manifest_committed_state_required_for_regeneration
intent: regeneration uses known generated ownership
input:
  files:
    .routa/manifest.json: missing
action: routa scaffold openapi.yaml on existing project
expected:
  behavior:
    - command warns that ownership cannot be proven
    - command switches to conservative preview mode
    - user must explicitly confirm any overwrite
failure:
  mode: no blind overwrite
```

## Manifest Minimum Shape

```json
{
  "version": 1,
  "openapi": {
    "baseline": ".routa/openapi-baseline.json"
  },
  "generated": [
    {
      "path": "routes/users/route.ts",
      "source": "openapi.yaml",
      "operationIds": ["listUsers"],
      "kind": "route"
    },
    {
      "path": "routes/users/schemas.ts",
      "source": "openapi.yaml",
      "operationIds": ["listUsers"],
      "kind": "schema"
    },
    {
      "path": ".routa/routes.gen.ts",
      "kind": "route-metadata"
    }
  ]
}
```

## Out of Scope

- Full package manager lockfile tracking.
- Runtime metadata registry persistence.
