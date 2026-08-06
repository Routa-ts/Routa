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

**Named outcome**:
A declared response possibility identified by a domain-relevant name and carrying its associated data.
_Avoid_: Loose response, raw status branch

**OpenAPI scaffold**:
The one-time conversion of an external OpenAPI document into editable Routa source contracts.
_Avoid_: Permanent OpenAPI ownership, continuous source replacement

**OpenAPI baseline**:
The accepted API contract against which Routa checks generated OpenAPI for drift and breaking changes.
_Avoid_: Current generated output

**Generated metadata**:
Deterministic, source-derived contract state used by Routa's types, runtime, and checks and reviewed alongside source.
_Avoid_: Disposable build artifact
