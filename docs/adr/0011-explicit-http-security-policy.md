# Explicit HTTP security policy preserves application ownership

Routa V1 will apply one application-wide HTTP security policy with fixed mode-independent defaults because implicit framework environment switches and competing response producers make transport behavior difficult to explain and verify. Whether CORS, managed headers and HTTPS enforcement are enabled are contract facts; origin and header lists, header values and proxy trust lists are runtime tuning values under ADR-0016, so an application may choose environment-specific values explicitly. CORS permission negotiation, supported browser headers and optional HTTPS share the existing response plan, while forwarded protocol requires its own opt-in through explicit trusted-peer IP/CIDR matching. Guardrails diagnose concrete declarations, at startup when they inspect tuning values, and applications retain authentication, authorization, CSRF, proxy/deployment correctness and policy meaning; this trades per-route profiles and dynamic policy callbacks for consistent enforcement. Runtime delivery remains pending.

The fixed defaults in development and production are:

- No cross-origin CORS grants.
- `X-Content-Type-Options: nosniff`.
- `Referrer-Policy: no-referrer`.
- HTTPS enforcement disabled.
- No framework-managed HSTS, CSP or browser-isolation headers until explicitly configured.
