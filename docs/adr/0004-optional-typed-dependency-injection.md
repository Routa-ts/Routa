# V1 includes optional typed dependency injection

Routa V1 supports optional typed wiring for application-owned dependencies at application, route-file, and method scopes because large projects need explicit lifetimes and precise test replacement. Plain imports remain first-class, while Routa does not generate services, require a container or decorators, or take ownership of business logic; this adds framework surface in exchange for scalable composition and testing without prescribing application architecture.
