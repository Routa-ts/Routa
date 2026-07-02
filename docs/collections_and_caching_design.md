# Collections and Caching Design (Group 4)

## Scope

This document records decisions for Group 4 in small parts.

## Part 4.1: Pagination

### Decisions

- Pagination is opt-in per route.
- Routa provides built-in helpers for both cursor pagination and offset pagination.
- Cursor pagination is the recommended pattern for public and product APIs.
- Offset pagination is supported for admin screens, simple lists, reports, and stable small datasets.
- Route contracts declare the selected pagination mode.
- Routa does not automatically paginate every collection.

### Cursor Pagination

- Cursor pagination uses opaque raw tokens.
- Cursor tokens hide internal ordering and storage details.
- Routa should validate cursor tokens rather than exposing token structure as public API.
- Cursor pagination should support both forward and backward navigation when the route enables it.

### Offset Pagination

- Offset pagination uses explicit numeric position inputs such as `limit` and `offset`.
- Offset pagination should be easy to configure, but not treated as the safest default for changing data.
- Routes using offset pagination should still declare allowed limits and bounds.

### Pagination Response Shape

- Routa supports raw tokens plus generated links.
- Paginated responses may expose `page.next` and `page.prev` as opaque tokens.
- Paginated responses may expose `links.next` and `links.prev` as ready-to-follow URLs.
- Links should contain the opaque token instead of requiring clients to understand token internals.

### Stable Ordering

- Paginated routes must define stable ordering.
- Stable ordering must include a unique tie-breaker.
- Example: `createdAt desc, id desc`.
- Unstable pagination configuration should fail during build, startup, or Routa check steps.

## Part 4.2: Filtering, Sorting, and Sparse Fields

### Decisions

- Filtering, sorting, and sparse fields are normal typed query params.
- The route query schema is the source of truth for accepted collection query inputs.
- Routa does not provide a separate filter DSL or filter allowlist system in v1.
- Developers define filter fields directly in their own query schema.
- Routa should provide schema helpers only for common sort and sparse field behavior.
- Sort and field helpers return schemas that developers compose into their own route query schema.
- Developers may extend, wrap, or ignore Routa's query helpers.

### Unknown Query Params

- Unknown query param behavior follows the schema parser.
- Strict query schemas reject unknown query params with `400 Bad Request`.
- Non-strict query schemas may strip or pass through unknown params according to schema behavior.
- Routa should recommend strict query schemas for API routes to catch client typos and integration mistakes.

### Sort Helper

- Routa should provide a `Sort` schema helper.
- Sort syntax is `sort=field` for ascending and `sort=-field` for descending.
- The helper accepts only fields declared by the developer.
- Example accepted values for `Sort(["createdAt", "email"])`:
  - `createdAt`
  - `-createdAt`
  - `email`
  - `-email`

### Sparse Fields Helper

- Routa should provide a `Fields` schema helper.
- Sparse field syntax is simple comma-separated fields.
- Example: `fields=id,name,email`.
- The helper accepts only fields declared by the developer.

### Example

```ts
import { Fields, Sort } from "@routa-ts/core/query/helpers";

const ListUsersQuery = z
	.object({
		status: z.enum(["active", "disabled"]).optional(),
		fields: Fields(["id", "name", "email"]),
		sort: Sort(["createdAt", "email"]),
	})
	.strict();
```

## Part 4.3: Query Execution Safety

### Decisions

- Query params are always validated through the route query schema.
- Routa does not add separate query validation logic outside the schema parser.
- The route query schema output is what handlers receive as `input.query`.
- If developers use coercions, transforms, or Routa query helpers, `input.query` receives parsed values.
- If developers do not parse or coerce a query value, `input.query` may receive a string.
- Limits and bounds are schema-owned.
- Routa may document max-limit recommendations, but should not force max limits.
- Routa does not warn just because a collection `GET` has no pagination.
- Pagination and query behavior remain developer-chosen.

### Helper Output

- `Sort` and `Fields` are Zod schema helpers.
- Helpers should build Zod enums or unions from developer-provided strings.
- Helpers should not use TypeScript enums.
- Runtime validation comes from Zod.
- Type safety comes from the inferred Zod schema.

### Sort Output

- `Sort` returns a normalized object.
- Output shape is `{ field, direction }`.
- `field` is first and `direction` is second.
- Sort defaults to `asc` when no `-` prefix is present.

Example:

```ts
Sort(["createdAt", "email"] as const);
// output: { field: "createdAt" | "email"; direction: "asc" | "desc" }
```

### Fields Output

- `Fields` returns an array of allowed field strings.
- Duplicate field helper configuration should be caught by TypeScript where possible.
- Duplicate client field values should fail validation.
- Routa should not silently dedupe duplicate fields.
- Duplicate client field errors should use a specific stable error code, such as `duplicate_query_field`.

Example:

```ts
Fields(["id", "name", "email"] as const);
// output: Array<"id" | "name" | "email">
```

## Part 4.4: HTTP Caching and Validators

### Decisions

- Routa owns HTTP cache metadata and conditional request behavior at the API boundary.
- Application/data caching, such as Redis or service-level cache lookup, remains application-owned.
- Cache config is per route.
- Default cache policy is `no-store`.
- Routa should provide direct-import helpers for common cache policies:
  - `NoStore`
  - `PrivateCache`
  - `PublicCache`

### Cache-Control

- Cache helpers generate standard `Cache-Control` headers.
- Routes may use `NoStore` for sensitive or non-cacheable responses.
- Routes may use `PrivateCache` for user-specific responses that only a private client cache may store.
- Routes may use `PublicCache` for responses that browsers, proxies, or CDNs may store.

### ETag

- ETag support is manual in v1.
- Routa should not provide automatic response-body hashing for ETags in v1.
- ETags should come from stable application or domain data, such as:
  - version
  - revision id
  - `updatedAt`
  - content hash
- ETags must be deterministic across server instances.
- ETags should not depend on local server memory or per-request randomness.
- ETags may exist independently from the route cache storage policy.
- Read revalidation with `If-None-Match` is mainly useful when the route opts into a cache policy that permits storage.
- If a route declares read-cache validators such as ETag or `Last-Modified` but keeps the default `no-store` policy, Routa should warn during build, startup, or Routa check steps.
- `If-Match` can still be useful for optimistic concurrency even when responses are `no-store`.

### If-None-Match

- Routa should handle `If-None-Match` automatically for `GET` and `HEAD` when the route defines an ETag.
- If the request ETag matches the route response ETag, Routa returns `304 Not Modified` with no body.
- If the ETag does not match, Routa returns the normal response with the current ETag.

### Last-Modified

- Routa supports `Last-Modified` as a secondary validator.
- `Last-Modified` is useful when a resource naturally has a stable update timestamp.
- ETag is preferred when both validators are available.
- If both ETag and `Last-Modified` are configured, ETag takes precedence for conditional requests.

### If-Match

- `If-Match` support is opt-in for mutation routes.
- Supported mutation methods are `PUT`, `PATCH`, and `DELETE`.
- `If-Match` protects writes from overwriting a newer resource version.
- Failed `If-Match` checks return `412 Precondition Failed`.
