# v0 Spec: Business Logic Boundary

## Feature

Trail separates HTTP route handling from user-owned business logic.

The route handler lives inside `route.ts`. The handler adapts typed input/context into application-owned business logic.

Trail does not generate service files in v0.

## Default Layout

```txt
routes/users/route.ts       # Trail-managed route contract and handler mapping
routes/users/schemas.ts     # Trail-managed route-local schemas by convention
<user-chosen app code>      # User-owned business logic
```

## Acceptance Cases

```yaml
case: v0_business_logic_not_generated
intent: generated routes do not create or own business logic files
input:
  path: /users
  operationId: listUsers
action: trail scaffold openapi.yaml
expected:
  files:
    - routes/users/route.ts
    - routes/users/schemas.ts
  behavior:
    - route handler contains HTTP boundary stub or TODO
    - manifest tracks generated HTTP boundary files and route metadata only
    - developer chooses where business logic lives
must_not:
  - generate services/users.ts
  - generate domain/users.ts
  - place business logic inside generated schema files
  - require business logic to live inside routes/
```

```yaml
case: v0_business_logic_preserved_on_regeneration
intent: user business logic survives OpenAPI changes
input:
  files:
    services/users.ts: user-created implementation
    modules/users/list-users.ts: user-created implementation
    .trail/manifest.json: tracks generated HTTP boundary files and route metadata only
  change:
    openapi.yaml adds GET /users/{id}
action: trail scaffold openapi.yaml
expected:
  behavior:
    - preview shows new route/schema files
    - services/users.ts is not overwritten
    - modules/users/list-users.ts is not overwritten
    - no service stub additions are generated
must_not:
  - replace user-created business logic files
```

## Handler Responsibility

Route handlers:

- receive validated input
- receive typed context
- call or delegate to application-owned code if the developer chooses
- return declared response variants

Application business logic:

- own business logic
- may call databases, queues, external APIs, or domain modules
- are not controlled by Trail regeneration
- may be organized as services, modules, use cases, hexagonal ports/adapters, feature folders, or any other structure

## Out of Scope

- Heavy DI container.
- Required class services.
- Runtime service replacement outside tests.
- Generated services.
- Service folder configuration.
