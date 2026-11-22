import type { RequestErrorCode, RequestErrorDiagnostic, RequestErrorReporter } from "./index.js";
import { observeRejection, writeFallbackLine } from "./fallback.js";

/** Calls the application's reporter for one failed request. It never throws and never waits. */
export type ReportRequestError = (error: unknown, diagnostic: RequestErrorDiagnostic) => void;

/**
 * Reads the `onRequestError` option once, at startup.
 *
 * @returns The reporter wrapped so it can never affect the request, or `undefined` when omitted
 * @throws {TypeError} When the option is present and not a function
 */
export function requestErrorReporterOf(option: unknown): ReportRequestError | undefined {
	if (option === undefined) {
		return undefined;
	}

	if (typeof option !== "function") {
		throw new TypeError(
			"onRequestError must be a function that receives the original error and its diagnostic. Omit it to report nothing.",
		);
	}

	return containReporter(option as RequestErrorReporter);
}

/**
 * Wraps a reporter so Routa calls it without waiting for it. A throw or a rejection writes one
 * fixed line to `console.error` for the application, the first time only. The line never holds
 * either error and never goes through the reporter or a Routa logger, so a failing reporter cannot
 * recurse, leak what it was given, or depend on logging being on.
 */
function containReporter(reporter: RequestErrorReporter): ReportRequestError {
	let reported = false;
	const failed = () => {
		if (!reported) {
			reported = true;
			writeFallbackLine(
				"routa.on_request_error.failed",
				"The onRequestError callback threw or rejected. Later failures of this callback in this application are not reported.",
			);
		}
	};

	return (error, diagnostic) => {
		try {
			const result: unknown = Reflect.apply(reporter, undefined, [error, diagnostic]);

			if (result !== undefined) {
				observeRejection(result, failed);
			}
		} catch {
			failed();
		}
	};
}

/**
 * Errors Routa created to report a contract violation it detected. Membership is recorded when
 * Routa creates the error, so classifying a failure never reads or inspects what was thrown.
 */
const violations = new WeakSet<object>();

/**
 * Errors Routa wraps around a value application code threw, mapped to that value. It is kept here
 * rather than read back from the wrapper's `cause`, which middleware can redefine.
 */
const wrapped = new WeakMap<object, unknown>();

/** Records that Routa created `error` to report a contract violation it detected. */
export function contractViolation<E extends object>(error: E): E {
	violations.add(error);
	return error;
}

/** Records that Routa created `error` around `thrown`, the value application code threw. */
export function wrapThrown<E extends object>(error: E, thrown: unknown): E {
	wrapped.set(error, thrown);
	return error;
}

/**
 * The value application code threw, when Routa wrapped it in `error`, or `error` itself. Only
 * Routa's own records are consulted, so this never throws, whatever `error` is.
 */
export function thrownValue(error: unknown): unknown {
	return isObject(error) && wrapped.has(error) ? wrapped.get(error) : error;
}

/**
 * Whether Routa detected a contract violation, or something failed that it did not expect.
 * Classified by what was thrown, from Routa's own records: never throws, whatever was thrown.
 */
export function requestErrorCode(thrown: unknown): RequestErrorCode {
	return isObject(thrown) && violations.has(thrown) ? "contract_violation" : "unexpected_failure";
}

function isObject(value: unknown): value is object {
	return (typeof value === "object" && value !== null) || typeof value === "function";
}
