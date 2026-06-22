# v0 Spec: Input Validation

## Feature

Trail validates OpenAPI scaffold input and generated route contracts before writing source.

## Acceptance Cases

```yaml
case: v0_input_invalid_openapi_document
intent: invalid OpenAPI does not generate source
input:
  file: openapi.yaml
  content: invalid yaml or invalid OpenAPI shape
action: trail scaffold openapi.yaml
expected:
  behavior:
    - command fails before writing files
    - error reports parse or schema issue
must_not:
  - create partial route files
```

```yaml
case: v0_input_missing_operation_id
intent: operation ids are required for stable generation
input:
  openapi:
    paths:
      /users:
        get:
          operationId: missing
action: trail scaffold openapi.yaml
expected:
  behavior:
    - command reports missing operationId
    - generated output is blocked or requires explicit generated-name acceptance
failure:
  mode: no unstable silent name generation
```

```yaml
case: v0_input_duplicate_operation_id
intent: duplicate operation ids cannot map to stable functions
input:
  openapi:
    paths:
      /users:
        get:
          operationId: getThing
      /tasks:
        get:
          operationId: getThing
action: trail scaffold openapi.yaml
expected:
  behavior:
    - command reports duplicate operationId
    - output is blocked until fixed
```

```yaml
case: v0_input_unsupported_media_type
intent: v0 only supports approved media types
input:
  openapi:
    requestBody:
      content:
        application/xml: {}
action: trail scaffold openapi.yaml
expected:
  behavior:
    - command reports unsupported media type for v0
    - no route is generated for unsupported contract unless user chooses an explicit placeholder path
```

```yaml
case: v0_input_bad_typescript_identifier
intent: generated names must be stable TypeScript identifiers
input:
  openapi:
    components:
      schemas:
        "123 bad name": {}
action: trail scaffold openapi.yaml
expected:
  behavior:
    - command reports invalid generated identifier
    - command suggests or requires explicit rename mapping
```

## Validation Output

Reports should include:

- severity
- file path
- OpenAPI path/method/component when available
- issue code
- short message
- suggested fix when possible

## Out of Scope

- Teaching full OpenAPI authoring.
- Trusting AI-generated OpenAPI without validation.
