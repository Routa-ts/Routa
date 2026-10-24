export type HandlerOutputIssue = {
	code: string;
	path: readonly PropertyKey[];
};

/** A handler or middleware produced output that breaks its declared response contract. */
export class InvalidHandlerOutputError extends Error {
	constructor(
		message: string,
		readonly issues?: readonly HandlerOutputIssue[],
	) {
		super(message);
	}
}
