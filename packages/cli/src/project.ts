import { existsSync } from "node:fs";
import { join } from "node:path";
import { callName, objectLiteral, propertyName, unwrapExpression } from "./ast.js";
import {
	applicationAuthentication,
	type AuthenticationMetadata,
	type AuthenticationRequirementMetadata,
	requirementCompositionDiagnostics,
} from "./authentication.js";
import { checks } from "./checks/index.js";
import { type ContractSchemaProjection, projectContractSchemas } from "./contract-schemas.js";
import { parseTypeScriptFile } from "./declarations.js";
import { writeGeneratedState } from "./generate.js";
import { applicationCorrelation } from "./request-identity.js";
import { discoverRoutes } from "./route-discovery.js";
import {
	applicationServices,
	type RouteServicesMetadata,
	type ServiceContractMetadata,
} from "./services.js";
import * as ts from "./typescript.js";

export type Diagnostic = {
	code: string;
	severity: "error" | "warning";
	message: string;
	file?: string | undefined;
	routePath?: string;
	suggestion?: string;
};

export type RouteMetadata = {
	file: string;
	path: string;
	methods: string[];
	responses: Record<string, number[]>;
	inputs: Record<string, RouteMethodInputMetadata>;
	middleware: MiddlewareMetadata[];
	methodMiddleware: Record<string, MiddlewareMetadata[]>;
	/**
	 * Every folder `middleware.ts` on the route's path, root first, including files with no export
	 * Routa reads. Startup loads each one and refuses a `requireAuth` guard export the chain omits.
	 * Written only when the project configures authentication, the one case a guard can run.
	 */
	middlewareFiles?: string[];
	/** The service contracts the route file declares, when it declares any. */
	services?: RouteServicesMetadata;
	deprecations?: Record<string, RouteDeprecationMetadata | undefined>;
	ctx: string[];
	groups: string[];
	segments: string[];
};

export type RouteMethodInputMetadata = {
	params: boolean;
	query: boolean;
	headers: boolean;
	cookies: boolean;
	body: boolean;
};

export type MiddlewareMetadata = {
	file: string;
	name: string;
	requires: string[];
	/** The requirement interface of middleware declared with `createMiddleware<Requirements>()`. */
	requiresServices?: ServiceContractMetadata;
	provides: string[];
	providesTypes: Record<string, string>;
	rejects: MiddlewareRejectMetadata[];
	security: Array<Record<string, string[]>>;
	permissions: string[];
	/** The schemes a `requireAuth` guard allows; present only on that guard. */
	authentication?: AuthenticationRequirementMetadata;
};

export type MiddlewareRejectMetadata = {
	type: string;
	status: number;
	description?: string;
	schema?: string;
};

export type RouteDeprecationMetadata = {
	replacement?: string;
};

export type ProjectValidationResult = {
	routes: RouteMetadata[];
	diagnostics: Diagnostic[];
	warnings: Diagnostic[];
	schemas: ContractSchemaProjection;
	/** The authentication contract `src/routa.ts` declares, when it declares one. */
	authentication?: AuthenticationMetadata;
	/** The lowercase header `src/routa.ts` reads correlation from, when correlation is on. */
	correlationHeader?: string;
};

/**
 * What reading a project's source found, gathered in one place for checks and generation: its
 * routes and middleware, the configuration facts `src/routa.ts` declares, and what reading
 * reported. Each part reads its files separately, so a file saved during a run can leave parts
 * from different versions of it.
 */
export type ProjectModel = {
	cwd: string;
	/** The parse session that read the project. Checks that inspect source parse through it. */
	parser: ts.SourceFileParser;
	routes: RouteMetadata[];
	/** The authentication contract `src/routa.ts` declares, when it declares one. */
	authentication: AuthenticationMetadata | undefined;
	/** The lowercase header `src/routa.ts` reads correlation from, when correlation is on. */
	correlationHeader: string | undefined;
	/** The application service contract `src/routa.ts` declares, when it declares one. */
	services: ServiceContractMetadata | undefined;
	schemas: ContractSchemaProjection;
	/** The errors reading each part reported. `checks` reports them in their place. */
	errors: {
		authentication: Diagnostic[];
		correlation: Diagnostic[];
		/** Route discovery's errors, then the errors of how each operation's guards compose. */
		routes: Diagnostic[];
		services: Diagnostic[];
	};
	/** The warnings reading reported, in the order commands print them. */
	warnings: Diagnostic[];
};

/**
 * Validates a Routa project and optionally generates route metadata when validation succeeds.
 *
 * @param cwd - The project root directory
 * @param options - Validation options
 * @param options.write - When `true` (default), write `.routa/routes.gen.ts` and
 *   `.routa/testing.gen.ts` after a clean validation
 * @returns The discovered routes and any validation diagnostics
 */
export function validateProject(
	cwd = process.cwd(),
	options: { write?: boolean } = {},
	parser?: ts.SourceFileParser,
): ProjectValidationResult {
	return parser
		? validateProjectInSession(cwd, options, parser)
		: ts.withSourceFileParsing(cwd, (ownedParser) =>
				validateProjectInSession(cwd, options, ownedParser),
			);
}

function validateProjectInSession(
	cwd: string,
	options: { write?: boolean },
	parser: ts.SourceFileParser,
): ProjectValidationResult {
	const write = options.write ?? true;
	const project = readProject(cwd, parser);
	const { routes, authentication, correlationHeader, schemas } = project;
	const diagnostics = checks.flatMap((check) => check(project));

	if (write && diagnostics.length === 0) {
		writeGeneratedState(cwd, routes, project.services, authentication, correlationHeader);
	}

	return {
		routes,
		diagnostics,
		warnings: project.warnings,
		schemas,
		...(authentication && { authentication }),
		...(correlationHeader && { correlationHeader }),
	};
}

/**
 * Builds one project model from the configuration, routes, middleware, and contract schemas,
 * and what reading each part reported. Each part reads its own files; see {@link ProjectModel}.
 */
function readProject(cwd: string, parser: ts.SourceFileParser): ProjectModel {
	const auth = applicationAuthentication(cwd, parser);
	const { authentication } = auth;
	const correlation = applicationCorrelation(cwd, parser, authentication);
	const correlationHeader = correlation.header;
	const discovery = discoverRoutes(cwd, parser, authentication);
	const routes = discovery.routes;
	const schemas = projectContractSchemas(cwd, routes, parser, {
		lifecycleHeaders: lifecycleHeadersEnabled(cwd, parser),
		...(authentication && { authentication }),
		...(correlationHeader && { correlationHeader }),
	});
	const services = applicationServices(cwd, parser);
	const discovered = [
		...discovery.diagnostics,
		...requirementCompositionDiagnostics(routes, authentication),
	];

	return {
		cwd,
		parser,
		routes,
		authentication,
		correlationHeader,
		services: services.services,
		schemas,
		errors: {
			authentication: auth.diagnostics,
			correlation: correlation.diagnostics,
			routes: discovered.filter((item) => item.severity !== "warning"),
			services: services.diagnostics,
		},
		warnings: [
			...auth.warnings,
			...correlation.warnings,
			...services.warnings,
			...discovered.filter((item) => item.severity === "warning"),
			...schemas.warnings,
		],
	};
}

/**
 * Reads whether `src/routa.ts` may turn lifecycle headers on.
 *
 * Lifecycle headers are a tuning-backed feature: a literal `false` or an omitted key keeps them
 * off, and any other value counts as possibly enabled. A configuration the source cannot be read
 * for the key, such as a variable, a call, a spread, or a computed key, counts the same way.
 * Generation never executes application modules, so ownership diagnostics apply to every
 * configuration the source can produce.
 */
function lifecycleHeadersEnabled(cwd: string, parser: ts.SourceFileParser): boolean {
	const file = join(cwd, "src/routa.ts");

	if (!existsSync(file)) {
		return false;
	}

	const sourceFile = parseTypeScriptFile(file, parser);
	let foundCall = false;
	let enabled = false;
	const visit = (node: ts.Node): void => {
		if (ts.isCallExpression(node) && callName(node.expression) === "createRouta") {
			foundCall = true;
			enabled ||= configMayEnableLifecycleHeaders(node.arguments[0]);
		}

		ts.forEachChild(node, visit);
	};

	visit(sourceFile);
	const hasDefaultExport = sourceFile.statements.some(
		(statement) =>
			(ts.isExportAssignment(statement) && !statement.isExportEquals)
			|| (ts.isExportDeclaration(statement)
				&& statement.exportClause
				&& ts.isNamedExports(statement.exportClause)
				&& statement.exportClause.elements.some((element) => element.name.text === "default")),
	);
	return enabled || (!foundCall && hasDefaultExport);
}

/** Walks a config in source order, so a later literal `false` overrides what a spread may hold. */
function configMayEnableLifecycleHeaders(argument: ts.Expression | undefined): boolean {
	if (!argument) {
		return false;
	}

	const config = objectLiteral(argument);

	if (!config) {
		return true;
	}

	let enabled = false;

	for (const member of config.properties) {
		if (ts.isSpreadAssignment(member) || ts.isComputedPropertyName(member.name)) {
			enabled = true;
		} else if (propertyName(member.name) === "lifecycleHeaders") {
			enabled =
				!ts.isPropertyAssignment(member)
				|| unwrapExpression(member.initializer).kind !== ts.SyntaxKind.FalseKeyword;
		}
	}

	return enabled;
}

/**
 * Formats diagnostics into a newline-separated report.
 *
 * @param diagnostics - Diagnostics to format
 * @returns The formatted diagnostic report
 */
export function formatDiagnostics(diagnostics: Diagnostic[]): string {
	return diagnostics
		.map((diagnostic) => {
			const severity = diagnostic.severity === "warning" ? "Warning: " : "";
			const location = diagnostic.file ? `${diagnostic.file}: ` : "";
			const suggestion = diagnostic.suggestion ? `\nSuggestion: ${diagnostic.suggestion}` : "";
			return `${severity}${diagnostic.code}: ${location}${diagnostic.message}${suggestion}`;
		})
		.join("\n");
}
