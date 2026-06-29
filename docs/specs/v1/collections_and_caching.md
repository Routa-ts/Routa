# v1 Spec: Collections and Caching

## Feature

Routa supports typed collection query helpers and HTTP cache metadata at the API boundary.

## Acceptance Cases

```yaml
case: v1_sort_helper_accepts_declared_fields_only
intent: sorting is schema-owned and allowlisted
input:
  query_schema:
    sort: Sort(["createdAt", "email"])
  request:
    query:
      sort: -createdAt
action: parse request
expected:
  behavior:
    - input.query.sort is { field: "createdAt", direction: "desc" }
```

```yaml
case: v1_fields_helper_rejects_duplicates
intent: sparse field duplicates are not silently deduped
input:
  query_schema:
    fields: Fields(["id", "name"])
  request:
    query:
      fields: id,id
action: parse request
expected:
  behavior:
    - validation fails
    - error code is stable, such as duplicate_query_field
```

```yaml
case: v1_etag_if_none_match_returns_304
intent: route cache validators control conditional GET
input:
  route:
    method: get
    etag: resource version
  request:
    headers:
      if-none-match: matching etag
action: handle request
expected:
  behavior:
    - response status is 304
    - response has no body
```

```yaml
case: v1_if_match_failed_returns_412
intent: mutation validators protect optimistic concurrency
input:
  route:
    method: patch
    ifMatch: enabled
  request:
    headers:
      if-match: stale etag
action: handle request
expected:
  behavior:
    - response status is 412
```

## Out of Scope for v0

- Automatic pagination for every collection.
- Application/data cache storage.
