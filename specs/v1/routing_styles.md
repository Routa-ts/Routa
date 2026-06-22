# v1 Spec: Routing Styles

## Feature

Trail supports both directory-style routes and flat dot routes. Both styles resolve into the same route graph.

## Route Styles

Directory style:

```txt
routes/users/route.ts
routes/users/$id/route.ts
```

Flat style:

```txt
routes/users.ts
routes/users.$id.ts
```

Mixed style is allowed in one project.

No config is required to choose a style.

## Acceptance Cases

```yaml
case: v1_routing_flat_collection
intent: flat collection route maps to collection path
input:
  file: routes/users.ts
action: compile route graph
expected:
  behavior:
    - route maps to /users
```

```yaml
case: v1_routing_flat_item
intent: flat dynamic route maps to item path
input:
  file: routes/users.$id.ts
action: compile route graph
expected:
  behavior:
    - route maps to /users/:id
    - id is available as route param
```

```yaml
case: v1_routing_mixed_styles_allowed
intent: projects can combine directory and flat routes
input:
  files:
    - routes/users/route.ts
    - routes/tasks.$id.ts
action: compile route graph
expected:
  behavior:
    - /users is loaded from directory style
    - /tasks/:id is loaded from flat style
must_not:
  - require route style config
```

```yaml
case: v1_routing_duplicate_conflict_fails
intent: two files cannot define the same method and path
input:
  files:
    - routes/users/route.ts
    - routes/users.ts
action: compile route graph
expected:
  behavior:
    - build/check fails
    - error reports both files and resolved path /users
must_not:
  - choose one route silently
```

```yaml
case: v1_routing_duplicate_path_split_methods_fails
intent: one path should be owned by one route module, even if methods differ
input:
  files:
    - routes/users.ts
    - routes/users/route.ts
action: compile route graph
expected:
  behavior:
    - fails as duplicate path ownership
must_not:
  - split methods for the same path across flat and directory files
```

## Design Rule

The route graph is the source of truth after parsing.

Directory and flat route files are just authoring styles. Once parsed, Trail should treat them identically.

## Out of Scope for v0

- Generated flat route output.
- Full mixed style support.
