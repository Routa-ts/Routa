/**
 * Failure containment shared by logger sinks and the request error reporter. Internal: no public
 * entry exports it.
 */

/**
 * Calls `onRejected` if what a sink or reporter returned rejects, without waiting for it. A native
 * promise, a subclass's instance included, gets the handler through the intrinsic `then`, so its
 * own `then` never runs and its rejection is always handled. Any other value is resolved as
 * `await` would resolve it, which runs a thenable's `then`. The fulfilled value is dropped: the
 * derived promise would otherwise read that value's `then`, whose throw nothing handles.
 *
 * A promise subclass whose `constructor`, `Symbol.species`, or species constructor throws cannot
 * be observed: every intrinsic that attaches a handler runs them first.
 *
 * @throws When `delivery` cannot be observed
 */
export function observeRejection(delivery: unknown, onRejected: () => void): void {
	try {
		// Throws a TypeError, before reading anything, for a value that is not a native promise.
		void Promise.prototype.then.call(delivery, () => undefined, onRejected);
	} catch {
		void Promise.prototype.then.call(Promise.resolve(delivery), () => undefined, onRejected);
	}
}

/**
 * Writes one fixed diagnostic line to `console.error`, outside every Routa logger, so it appears
 * even when logging is off or the logger is what failed. It never throws.
 *
 * @param event - A fixed event name
 * @param message - A fixed message, which never holds the failure's text
 */
export function writeFallbackLine(event: string, message: string): void {
	try {
		globalThis.console.error(
			JSON.stringify({ level: "error", event, message, timestamp: new Date().toISOString() }),
		);
	} catch {
		// Nowhere is left to report to.
	}
}
