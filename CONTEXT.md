# Routa

Routa is a schema-first, OpenAPI-aware REST framework that makes HTTP contracts explicit in TypeScript while leaving business architecture to the application.

## Language

**HTTP boundary**:
The transport-facing part of an application that Routa owns: routing, validation, middleware context, named outcomes, serialization, and OpenAPI.
_Avoid_: Business layer, application architecture

**Application code**:
Developer-owned services, use cases, domain models, persistence, authentication, and authorization called from the HTTP boundary.
_Avoid_: Routa service layer, framework-owned business logic

**Injected service**:
An application-owned dependency optionally wired through Routa for typed access and test replacement; Routa does not own its business behavior.
_Avoid_: Routa service, framework service, required service layer

**Route file**:
A source module that owns one URL path and all HTTP methods declared for that path.
_Avoid_: Controller, one file per verb

**Route contract**:
The declaration for one HTTP method, including accepted input, middleware, named outcomes, metadata, and the handler boundary.
_Avoid_: Controller action, loose handler

**Route graph**:
The validated project-wide model of paths, methods, middleware chains, context, and contract metadata.
_Avoid_: Route registry

**Middleware contract**:
A declaration of the context middleware requires and provides, plus the early outcomes it may produce.
_Avoid_: Invisible hook, side-effect middleware

**Authentication contract**:
A provider-neutral HTTP-boundary agreement automatically applied to every route when configured, yielding anonymous or authenticated request context through Routa's credential orchestration and application-owned authentication; otherwise no authentication context is registered.
_Avoid_: Auth provider, authentication implementation, framework-owned identity or session

**Principal**:
An application-defined identity authenticated for the current request, with a stable `id` and `type`; one application-wide schema configured in `routa.ts` validates and types every principal before it becomes `ctx.auth.principal`.
_Avoid_: User, account, Better Auth user

**Credential scheme**:
A uniquely transported, application-named description of where an HTTP credential is carried, paired with application-owned authentication and its public security metadata; overlapping built-in transports or declared custom transport identities are configuration errors.
_Avoid_: Auth provider, login method, Better Auth mode

**Authentication requirement**:
A middleware guard that rejects anonymous request context and narrows downstream context to a principal authenticated through one of its allowed credential schemes; inherited folder, route, and method requirements compose by intersecting their allowed schemes before credential selection, and `routa check` rejects an empty effective set.
_Avoid_: Authenticator, permission, role guard, authorization policy

**Authenticator**:
An application-owned callback that evaluates an extracted credential and explicitly returns either a principal candidate or rejection; rejection becomes `authenticationFailed` (`401`) without fallback or anonymous downgrade, while unexpected failures are thrown and remain server errors.
_Avoid_: Nullable user lookup, provider adapter, authentication middleware

**Authentication challenge**:
Public `WWW-Authenticate` metadata associated with a credential scheme and returned on `401` outcomes, using a safe generated default unless application code supplies a validated static override; missing or disallowed credentials challenge every effective allowed scheme, while an invalid selected credential challenges only its scheme.
_Avoid_: Login redirect, credential, provider failure details

**Named outcome**:
A declared response possibility identified by a domain-relevant name and carrying its associated data.
_Avoid_: Loose response, raw status branch

**OpenAPI scaffold**:
The one-time conversion of an external OpenAPI document into editable Routa source contracts.
_Avoid_: Permanent OpenAPI ownership, continuous source replacement

**Integration scaffold**:
A generation-time recipe that writes application-owned integration code using public Routa APIs and direct upstream dependencies.
_Avoid_: Routa integration package, runtime plugin, hidden adapter

**OpenAPI baseline**:
The accepted API contract against which Routa checks generated OpenAPI for drift and breaking changes.
_Avoid_: Current generated output

**Generated metadata**:
Deterministic, source-derived contract state used by Routa's types, runtime, and checks and reviewed alongside source.
_Avoid_: Disposable build artifact
