# Route contracts in source are authoritative

Routa uses schema-backed TypeScript route contracts as its continuing source of truth because types, runtime validation, generated metadata, and OpenAPI need one enforceable model. A reviewed OpenAPI document may scaffold the initial source, but route files own the contract after import; this trades arbitrary route shapes for synchronized editor, runtime, and documentation behavior.
