import type { Diagnostic, ProjectModel } from "../project.js";
import { deprecationReplacementDiagnostics } from "./deprecation-replacements.js";
import { duplicateOperationIdDiagnostics } from "./duplicate-operation-ids.js";
import { duplicateRouteDiagnostics } from "./duplicate-routes.js";
import { duplicateSchemaDiagnostics } from "./duplicate-schema-names.js";
import { middlewareContextDiagnostics } from "./middleware-context.js";
import { middlewareOrderDiagnostics } from "./middleware-order.js";
import { middlewareRejectStatusDiagnostics } from "./middleware-reject-status.js";
import { missingSuccessResponseDiagnostics } from "./missing-success-responses.js";
import { projectStructureDiagnostics } from "./project-structure.js";
import { runResultShapeDiagnostics } from "./run-result-shape.js";
import { serviceCollisionDiagnostics } from "./service-collisions.js";
import { serviceRequirementDiagnostics } from "./service-requirements.js";

/** Reports what is wrong with a project, from what reading it found. */
export type Check = (project: ProjectModel) => Diagnostic[];

/**
 * Every check, in the order `validateProject` reports their diagnostics. The errors reading
 * reported keep their place among them.
 */
export const checks: readonly Check[] = [
	projectStructureDiagnostics,
	({ errors }) => errors.authentication,
	({ errors }) => errors.correlation,
	({ errors }) => errors.routes,
	({ errors }) => errors.services,
	runResultShapeDiagnostics,
	duplicateRouteDiagnostics,
	duplicateOperationIdDiagnostics,
	deprecationReplacementDiagnostics,
	missingSuccessResponseDiagnostics,
	duplicateSchemaDiagnostics,
	middlewareOrderDiagnostics,
	middlewareContextDiagnostics,
	middlewareRejectStatusDiagnostics,
	serviceCollisionDiagnostics,
	serviceRequirementDiagnostics,
	({ schemas }) => schemas.diagnostics,
];
