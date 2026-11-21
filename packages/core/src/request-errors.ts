import { AuthenticationContractError } from "./authentication.js";
import { InvalidHandlerOutputError } from "./handler-output-error.js";
import type { RequestErrorCode, RequestErrorDiagnostic, RequestErrorReporter } from "./index.js";
import { observeRejection, writeFallbackLine } from "./logger.js";

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

/** Whether Routa detected a contract violation, or something failed that it did not expect. */
export function requestErrorCode(error: unknown): RequestErrorCode {
	return error instanceof InvalidHandlerOutputError || error instanceof AuthenticationContractError
		? "contract_violation"
		: "unexpected_failure";
}
