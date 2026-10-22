# Bound transport without inventing work completion

Routa V1 will enforce one application-wide transport contract at its managed Node listener by setting fixed defaults on Node's native HTTP server options, separate from parsing, execution and shutdown policy. It closes unread request connections instead of silently draining arbitrary input, imposes no total stream duration, while application resources remain tied to actual execution, producer and cleanup completion. This trades persistent connections and implicit host defaults for bounded transport behavior without treating socket closure as forced cancellation; runtime delivery remains pending. Limit values are runtime tuning values under ADR-0016.

The fixed defaults in development, test and production are:

- Initial headers have a 16 KiB byte limit and a 100-field limit, counting repeated fields separately.
- Complete-header receipt has a 10-second deadline. Complete-request receipt has a 60-second deadline, including headers.
- Idle keep-alive between requests is limited to 5 seconds.
- The optional connection-count cap is disabled.

V1 defers separate trailer limits and a stalled-write timeout because both need custom socket handling. Node has no separate trailer limits. Its socket inactivity timeout (`server.timeout` and `server.setTimeout`) treats any idle socket as stalled, including a healthy stream whose producer is quiet, so it is not the write-only, completion-aware timeout this contract needs. Configuration is application-wide. Only the complete-request receipt timeout may be disabled; header limits and idle keep-alive remain finite. Socket closure does not enable execution cancellation by itself or change the existing optional disconnect-cancellation policy.
