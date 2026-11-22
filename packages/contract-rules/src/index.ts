/**
 * Rules core and the CLI both enforce, written once. Core and the CLI bundle this package, so no
 * published package depends on it.
 */
export {
	correlationHeaderProblem,
	type CorrelationHeaderProblem,
	correlationValueSchema,
	defaultCorrelationHeader,
	type HeaderCredentialScheme,
	isCorrelationValue,
	isHeaderName,
	requestIdHeader,
	reservedResponseHeaders,
} from "./headers.js";
export { reservedAuthContext, reservedContext, type ReservedContextKey } from "./context.js";
export { requestErrorCodes, requestErrorStages } from "./request-errors.js";
