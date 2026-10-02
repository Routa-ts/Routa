# Operational probes report application-owned readiness

Routa's opt-in probes own HTTP signaling while applications define required dependency checks and deployment platforms own traffic routing and restart policy. Probes preserve framework-wide authentication, protection, and shutdown admission but do not inherit filesystem application middleware. Shared readiness evaluations retain their initiating request capacity and application resources until callbacks actually settle, so timeout or disconnect cannot hide unfinished work or make cached readiness override shutdown.
