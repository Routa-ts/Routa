# Track stream producer completion separately from transmission

Routa V1 treats stream-production completion as an explicit contract, independent of body EOF, cancellation and observed transmission. Native cancellation does not join arbitrary producer work, so request-scoped services remain available until declared production and transmission settle, followed by registered cleanup and capacity release. The Routa streaming helper accounts for its awaited producer work and finalizers; native producers report completion themselves, and unreported detached work receives no framework lifetime guarantee.

This extends streaming lifetimes while preserving buffered cleanup, canonical request cancellation and application ownership of resources. Runtime implementation remains pending.
