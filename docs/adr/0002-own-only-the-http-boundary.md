# Routa owns only the HTTP boundary

Routa owns routing, transport validation, middleware context, named responses, serialization, and OpenAPI while the application owns services, use cases, domain models, persistence, authentication, and authorization. This boundary keeps Routa opinionated where HTTP consistency matters without forcing an application architecture on its users.
