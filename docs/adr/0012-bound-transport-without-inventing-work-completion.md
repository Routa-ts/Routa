# Bound transport without inventing work completion

Routa V1 will enforce one source-visible, mode-independent transport contract at its managed Node listener, separate from parsing, execution and shutdown policy. It closes unread request connections and stalled output instead of silently draining arbitrary input or imposing a total stream duration, while application resources remain tied to actual execution, producer and cleanup completion. This trades persistent connections and implicit host defaults for bounded transport behavior without treating socket closure as forced cancellation; runtime delivery remains pending.

The fixed defaults in development, test and production are:

- Initial headers and the separate trailer section each have a 16 KiB byte limit and a 100-field limit, counting repeated fields separately.
- Complete-header receipt has a 10-second deadline. Complete-request receipt has a 60-second deadline, including headers.
- Idle keep-alive between requests is limited to 5 seconds.
- Pending response writes and final flushing have a 30-second stall timeout. Observable local write completion resets it; application stream silence is excluded.
- The optional connection-count cap is disabled.

Configuration is application-wide. Only complete-request receipt and stalled-write timeouts may be disabled; header limits and idle keep-alive remain finite. Socket closure does not enable execution cancellation by itself or change the existing optional disconnect-cancellation policy.
