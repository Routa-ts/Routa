import type { RequestErrorDiagnostic, RequestErrorReporter } from "@routa-ts/core";

/** One error the tracker captured, with the tags it was sent with. */
export type CapturedError = {
	readonly error: unknown;
	readonly tags: RequestErrorDiagnostic;
};

/**
 * A stand-in for an error tracking service such as Sentry. It keeps captured errors in memory so
 * the example can show what a tracker receives. A real tracker client sends them to its service,
 * and the application owns that client's configuration, buffering, and flushing.
 */
class ErrorTracker {
	readonly captured: CapturedError[] = [];

	capture(error: unknown, tags: RequestErrorDiagnostic): void {
		this.captured.push({ error, tags });
	}
}

export const errorTracker = new ErrorTracker();

/**
 * Forwards each unexpected request failure to the tracker: the original error, which may hold
 * application detail, and Routa's diagnostic as tags, so the tracker's event and Routa's
 * `http.error` log share a request ID. It never writes the error through Routa's logger, whose
 * events stay free of error text. Routa has already chosen the response and does not wait for
 * this.
 */
export const reportRequestError: RequestErrorReporter = (error, diagnostic) => {
	errorTracker.capture(error, diagnostic);
};
