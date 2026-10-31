---
"@routa-ts/core": minor
"@routa-ts/cli": minor
---

Add typed application services, and reserve `ctx.services` for them.

- `defineServices<AppServices>()` fixes a service contract and returns a helper: `const defineAppServices = defineServices<AppServices>();`, then `createRouta({ services: defineAppServices(factory) })`. The inline `defineServices<AppServices>()(factory)` is equivalent. Factories may be sync or async and receive `{ logger, onCleanup }`. TypeScript rejects a factory that misses a service or returns an incompatible one, and a contract with optional services or an index signature.
- `routa check` and `routa generate` read the contract from source without importing application modules or running the factory. `.routa/routes.gen.ts` gains `routaApplicationServices`, the sorted service names, and `RoutaApplicationServices`, a type-only reference to the contract that types `ctx.services` in handlers. Handlers see the contract, never the factory's implementations. Projects without services get byte-identical generated files and no `ctx.services`. Service contracts never reach OpenAPI. New diagnostics: `ROUTA_SERVICES_UNRESOLVED`, `ROUTA_SERVICES_CONTRACT_UNRESOLVED`, and `ROUTA_SERVICES_CONTRACT_UNSUPPORTED`.
- `routa dev` and `routa start` construct the services once, before listening, and fail startup when the returned names differ from the contract's. `ctx.services` is frozen and cannot be reassigned; the services themselves stay mutable.
- `onCleanup` registers release callbacks. Routa awaits them in reverse registration order and attempts every one. A factory failure runs the callbacks already registered, then fails startup with the factory's error. A listener failure, such as a taken port, logs `api.start_failed` and releases the services. Cleanup failures are logged as `services.cleanup_failed` and never replace the startup error. Process signals do not run cleanup yet.
- `createApplication(routes, options)` in `@routa-ts/core/hono` creates one application instance with `fetch` and `dispose`. `dispose()` stops accepting requests, waits for accepted ones to settle, then runs cleanup once; repeated and concurrent calls share its outcome, and it rejects with an `AggregateError` when cleanup failed.
- `ctx.services` is reserved even without services. TypeScript rejects middleware that provides `services` or passes it to `next()`, including through named bindings. `routa check` reports `ROUTA_CONTEXT_RESERVED`. Registration rejects a `services` provides schema hidden by a cast, and a request fails with `500` when `createContext`, `next()`, or a direct write claims `ctx.services`.
- `routa check` now follows a `provides` that names a `const` object literal, locally or through an import, so its keys reach generated context. A `provides` it cannot read, such as a call or a spread, reports `ROUTA_MIDDLEWARE_PROVIDES_UNRESOLVED` instead of providing nothing.

Migration: rename any middleware context key named `services`, and update the handlers that read it. Replace a `provides` built by a call or a spread with an object literal or a named `const` object literal.
