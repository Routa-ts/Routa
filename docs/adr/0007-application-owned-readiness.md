# Operational probes report application-owned readiness

Routa's opt-in probes own HTTP signaling while applications define required dependency checks and deployment platforms own traffic routing and restart policy. Probes preserve framework-wide authentication, protection, and shutdown admission but do not inherit filesystem application middleware. Shared readiness evaluations retain their initiating request capacity and application resources until callbacks actually settle, so timeout or disconnect cannot hide unfinished work or make cached readiness override shutdown.

Both endpoints are disabled unless explicitly configured. `/health` and `/ready` are default paths only after their respective probes are enabled. This supersedes the automatic `/health` proposal in [Part 5.3 of the historical operations design](../runtime_and_operations_design.md#part-53-health-readiness-and-liveness). Runtime implementation remains pending.
