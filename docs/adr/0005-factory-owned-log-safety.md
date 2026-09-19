# V1 logger factories own safety before application sinks

Routa V1 requires configured loggers to come from its public logger factory so mandatory sanitization and protected request identity apply before any output backend receives an event. Applications integrate Pino or other backends through ordinary sinks and retain ownership of their resources; this intentionally replaces arbitrary logger implementations with an explicit migration to sinks.

Plain-import services can share an application logger and receive a request logger through ordinary function arguments when correlation is needed. Routa does not introduce ambient request context for logging, and logging or reporting failures must preserve request behavior; an optional original-error reporter observes failures without choosing responses.
