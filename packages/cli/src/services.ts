import { existsSync } from "node:fs";
import { join, relative, sep } from "node:path";
import {
	callName,
	createRouteObject,
	objectLiteral,
	objectProperties,
	propertyName,
	resolveImportFile,
	routeConfigObject,
	unwrapExpression,
} from "./ast.js";
import { compareText } from "./compare-text.js";
import { boundDeclaration, namedImportMap, parseTypeScriptFile } from "./declarations.js";
import type { Diagnostic } from "./project.js";
import * as ts from "./typescript.js";

/** A service contract one scope declares, read from source. */
export type ServiceContractMetadata = {
	/** The module that exports the contract, relative to the project root. */
	file: string;
	/** The name that module exports the contract under. */
	name: string;
	/** The contract's service names, sorted. */
	names: string[];
};

/** The service contracts a route file declares: its own, and each method's. */
export type RouteServicesMetadata = {
	routeFile?: ServiceContractMetadata;
	methods?: Record<string, ServiceContractMetadata>;
};

const configFile = "src/routa.ts";

/** How many named bindings Routa follows from `services` to its `defineServices` call. */
const maxBindingDepth = 8;

/**
 * Reads the application service contract declared in `src/routa.ts` without executing it.
 *
 * The documented forms are `services: defineAppServices(factory)`, where
 * `const defineAppServices = defineServices<AppServices>()`, and the inline
 * `services: defineServices<AppServices>()(factory)`. Each binding along the way may be a local
 * `const` or a relative import. A declaration Routa cannot follow is an error, not an empty set.
 *
 * @returns The contract metadata when services are declared, diagnostics for declarations Routa
 *   cannot read, and a warning when an unreadable spread or computed key may hide `services`
 */
export function applicationServices(
	cwd: string,
	parser: ts.SourceFileParser,
): {
	services?: ServiceContractMetadata;
	diagnostics: Diagnostic[];
	warnings: Diagnostic[];
} {
	if (!existsSync(join(cwd, configFile))) {
		return { diagnostics: [], warnings: [] };
	}

	const { declaration, hidden } = routaConfigMember(cwd, parser, "services");
	// Tuning values may be runtime expressions, so a config Routa cannot read is not an error.
	const warnings: Diagnostic[] =
		hidden.length > 0
			? [
					{
						code: "ROUTA_SERVICES_SPREAD_UNRESOLVED",
						severity: "warning",
						message: `The createRouta config in ${configFile} has a spread, computed key, or config argument that cannot be statically read, so application services inside it cannot be read.`,
						file: configFile,
						suggestion:
							"Declare application services as a visible services member of the createRouta object, after any spread, or spread a const object literal. Startup rejects services that routa generate could not read.",
					},
				]
			: [];

	if (!declaration) {
		return { diagnostics: [], warnings };
	}

	return {
		...declaredContract(cwd, declaration, parser, `Application services in ${configFile}`, "App"),
		warnings,
	};
}

/**
 * Reads the service contracts a route file declares on its route root and on each inline
 * `createRoute` method, in the same forms as application services, without executing the file.
 *
 * @param file - The route file, relative to `cwd`
 */
export function routeServices(
	cwd: string,
	file: string,
	parser: ts.SourceFileParser,
): { services?: RouteServicesMetadata; diagnostics: Diagnostic[] } {
	const routeConfig = routeConfigObject(parseTypeScriptFile(join(cwd, file), parser));
	const services: RouteServicesMetadata = {};
	const diagnostics: Diagnostic[] = [];
	const read = (object: ts.ObjectLiteralExpression, label: string, example: string) => {
		const { node, hidden } = servicesValue(object);

		if (hidden) {
			diagnostics.push({
				code: "ROUTA_SERVICES_SPREAD_UNRESOLVED",
				severity: "warning",
				message: `${label} in ${file} may sit in a spread or computed key that cannot be statically read.`,
				file,
				suggestion:
					"Declare services as a visible services member, after any spread. Startup rejects services that routa generate could not read.",
			});
		}

		if (!node) {
			return undefined;
		}

		const declared = declaredContract(cwd, { file, node }, parser, `${label} in ${file}`, example);
		diagnostics.push(...declared.diagnostics);
		return declared.services;
	};

	const routeFile = routeConfig && read(routeConfig, "Route-file services", "Orders");

	if (routeFile) {
		services.routeFile = routeFile;
	}

	for (const property of routeConfig ? objectProperties(routeConfig) : []) {
		const key = propertyName(property.name);
		const method = key && key !== "services" && createRouteObject(property.initializer);
		const contract = method && read(method, `${key.toUpperCase()} services`, "Checkout");

		if (contract) {
			services.methods = { ...services.methods, [key as string]: contract };
		}
	}

	return {
		...(services.routeFile || services.methods ? { services } : {}),
		diagnostics,
	};
}

/**
 * Follows one scope's `services` value to its contract.
 *
 * @param label - Names the declaration in messages, such as `Application services in src/routa.ts`
 * @param example - The contract name prefix the suggestion uses, such as `App`
 */
function declaredContract(
	cwd: string,
	declaration: { file: string; node: ts.Node },
	parser: ts.SourceFileParser,
	label: string,
	example: string,
): { services?: ServiceContractMetadata; diagnostics: Diagnostic[] } {
	const contract = ts.isExpression(declaration.node)
		? factoryContract(cwd, declaration.file, declaration.node, parser, 0)
		: undefined;

	if (!contract) {
		return {
			diagnostics: [
				{
					code: "ROUTA_SERVICES_UNRESOLVED",
					severity: "error",
					message: `${label} cannot be statically resolved to a service contract.`,
					file: declaration.file,
					suggestion: `Declare \`const define${example}Services = defineServices<${example}Services>();\` and set \`services: define${example}Services(factory)\`, or write \`services: defineServices<${example}Services>()(factory)\`. Each binding must be a const declaration or a relative import.`,
				},
			],
		};
	}

	return serviceContract(cwd, contract.file, contract.type, parser, {
		noun: "Service contract",
		subject: "the contract",
		usage: "defineServices<AppServices>()",
	});
}

/**
 * A part of the `createRouta` config Routa cannot read, which may hold a member: a spread, a
 * config argument, or a default export whose `value` it cannot follow, or a computed `key` it
 * cannot read.
 */
export type HiddenPart = {
	readonly kind: "value" | "key";
	/** The module the part is written in, relative to the project root. */
	readonly file: string;
	readonly node: ts.Node;
};

type ConfigMember = {
	/** The member's value, and the module it is written in. */
	declaration?: { file: string; node: ts.Node } | undefined;
	/** The parts Routa cannot read that may hold the member, after any visible member. */
	hidden: readonly HiddenPart[];
};

/**
 * Finds a member, such as `services`, of the config `src/routa.ts` exports as default, the config
 * Routa loads at startup. The export, its `createRouta` argument, and each spread in it are read
 * through {@link configValue}. Any part it cannot follow may hide the member.
 */
export function routaConfigMember(
	cwd: string,
	parser: ts.SourceFileParser,
	member: string,
): ConfigMember {
	const exported = defaultExport(parseTypeScriptFile(join(cwd, configFile), parser));

	if (!exported) {
		return { hidden: [] };
	}

	const config = configValue(cwd, parser, configFile, exported, 0);

	if (!config) {
		return { hidden: [] };
	}

	return ts.isObjectLiteralExpression(config.node)
		? objectMember(cwd, config.file, config.node, parser, 1, member)
		: { hidden: [{ kind: "value", ...config }] };
}

/**
 * Follows a part of the config, such as the default export, the `createRouta` argument, or a
 * spread, to the value it stands for: through `const` bindings, imports, and re-exports, and into
 * the argument of each `createRouta` call, which returns its argument unchanged. The checker
 * resolves bindings without running any module.
 *
 * @param file - The module containing `node`, relative to `cwd`
 * @returns The object literal it found, or the node it stopped at as written, so its type keeps
 *   any assertion, with the module it is written in; `undefined` for a `createRouta()` call
 *   without a config, which holds no member
 */
function configValue(
	cwd: string,
	parser: ts.SourceFileParser,
	file: string,
	node: ts.Node,
	depth: number,
): { file: string; node: ts.Node } | undefined {
	const bound = boundValue(cwd, parser, file, node);
	const value = ts.isExpression(bound.node) ? unwrapExpression(bound.node) : bound.node;

	if (ts.isObjectLiteralExpression(value)) {
		return { file: bound.file, node: value };
	}

	if (
		!ts.isCallExpression(value)
		|| callName(value.expression) !== "createRouta"
		|| depth >= maxBindingDepth
	) {
		return bound;
	}

	const [argument] = value.arguments;
	return argument && configValue(cwd, parser, bound.file, argument, depth + 1);
}

/**
 * What a module exports as default: the expression of `export default`, or the name in
 * `export { config as default }`, which may re-export from another module.
 */
function defaultExport(sourceFile: ts.SourceFile): ts.Node | undefined {
	for (const statement of sourceFile.statements) {
		if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
			return statement.expression;
		}

		if (
			ts.isExportDeclaration(statement)
			&& !statement.isTypeOnly
			&& statement.exportClause
			&& ts.isNamedExports(statement.exportClause)
		) {
			const element = statement.exportClause.elements.find((item) => item.name.text === "default");

			if (element) {
				// The checker resolves the exported name to what it names, here or in the source module.
				return element.name;
			}
		}
	}
}

/**
 * Follows a name to the value it is bound to: through imports and re-exports, to a `const`
 * initializer or an `export default` expression, which the checker resolves without running any
 * module. It stops at any other node, such as a call, or a binding it cannot follow.
 *
 * @param file - The module containing `node`, relative to `cwd`
 * @returns The node it stopped at, as written, and the module it is written in
 */
function boundValue(
	cwd: string,
	parser: ts.SourceFileParser,
	file: string,
	node: ts.Node,
	depth = 0,
): { file: string; node: ts.Node } {
	const value = ts.isExpression(node) ? unwrapExpression(node) : node;
	const target =
		ts.isIdentifier(value) && depth <= maxBindingDepth
			? parser.withChecker(join(cwd, file), (checker) => {
					const symbol = checker.getSymbolAtLocation(value);
					const resolved =
						symbol && symbol.flags & ts.SymbolFlags.Alias
							? checker.getAliasedSymbol(symbol)
							: symbol;
					const [declaration, ...others] = resolved?.declarations ?? [];
					const declared = others.length === 0 ? declaration?.resolve() : undefined;
					return declared && { fileName: declared.getSourceFile().fileName, pos: declared.pos };
				})
			: undefined;

	if (!target) {
		return { file, node };
	}

	// Read the declaration from this parser's own parse of its module, where later reads find it.
	const declaredFile = relative(cwd, target.fileName);
	const declared = boundInitializer(
		parseTypeScriptFile(join(cwd, declaredFile), parser),
		target.pos,
	);

	return declared ? boundValue(cwd, parser, declaredFile, declared, depth + 1) : { file, node };
}

/**
 * The value a top-level declaration at `pos` binds: an `export default` expression, or the
 * initializer of a `const`.
 */
function boundInitializer(sourceFile: ts.SourceFile, pos: number): ts.Expression | undefined {
	for (const statement of sourceFile.statements) {
		if (ts.isExportAssignment(statement) && !statement.isExportEquals && statement.pos === pos) {
			return statement.expression;
		}

		if (
			ts.isVariableStatement(statement)
			&& (statement.declarationList.flags & ts.NodeFlags.Const) !== 0
		) {
			const declaration = statement.declarationList.declarations.find((item) => item.pos === pos);

			if (declaration) {
				return declaration.initializer;
			}
		}
	}
}

/**
 * Reads a member from a config object in source order, so a later member replaces an earlier
 * one as it does at runtime. A spread that {@link configValue} follows to an object literal, such
 * as a `const` bound to one or to a `createRouta` call, declared locally or imported, is read like
 * members written in place.
 *
 * @param file - The module containing `object`, relative to `cwd`
 */
function objectMember(
	cwd: string,
	file: string,
	object: ts.ObjectLiteralExpression,
	parser: ts.SourceFileParser,
	depth: number,
	name: string,
): ConfigMember {
	let found: ConfigMember = { hidden: [] };

	for (const property of object.properties) {
		if (ts.isSpreadAssignment(property)) {
			const spread =
				depth <= maxBindingDepth
					? configValue(cwd, parser, file, property.expression, depth)
					: { file, node: property.expression };
			const member: ConfigMember = !spread
				? { hidden: [] }
				: ts.isObjectLiteralExpression(spread.node)
					? objectMember(cwd, spread.file, spread.node, parser, depth + 1, name)
					: { hidden: [{ kind: "value", ...spread }] };
			found = member.declaration
				? member
				: { declaration: found.declaration, hidden: [...found.hidden, ...member.hidden] };
		} else {
			const key = memberKey(property.name);

			if (key === undefined) {
				const hiddenKey = ts.isComputedPropertyName(property.name)
					? property.name.expression
					: property.name;
				found = { ...found, hidden: [...found.hidden, { kind: "key", file, node: hiddenKey }] };
			} else if (key === name) {
				// A visible member replaces whatever an earlier unreadable part held.
				found = { declaration: { file, node: memberValue(property) }, hidden: [] };
			}
		}
	}

	return found;
}

/**
 * A config member's key. A computed key that is a string or number literal, such as
 * `["correlation"]`, is the plain key it spells; any other computed key cannot be read.
 */
function memberKey(name: ts.PropertyName): string | undefined {
	if (!ts.isComputedPropertyName(name)) {
		return propertyName(name);
	}

	const key = unwrapExpression(name.expression);
	return ts.isStringLiteralLike(key) || ts.isNumericLiteral(key) ? key.text : undefined;
}

/**
 * Finds the value of a route root's or method's `services` member, including one written as
 * `["services"]`. A member Routa cannot read, such as a getter or a computed key, yields the
 * member itself, which `declaredContract` reports as unresolved instead of ignoring it. A spread
 * or a computed key that is not a literal may also hold `services`; `hidden` reports one that
 * no visible member follows.
 */
function servicesValue(object: ts.ObjectLiteralExpression): { node?: ts.Node; hidden: boolean } {
	let found: { node?: ts.Node; hidden: boolean } = { hidden: false };

	for (const property of object.properties) {
		if (ts.isSpreadAssignment(property)) {
			found = { ...found, hidden: true };
		} else if (ts.isComputedPropertyName(property.name)) {
			const key = property.name.expression;
			found =
				ts.isStringLiteralLike(key) && key.text === "services"
					? { node: property, hidden: false }
					: { ...found, hidden: true };
		} else if (propertyName(property.name) === "services") {
			found = { node: memberValue(property), hidden: false };
		}
	}

	return found;
}

/**
 * The node holding an object member's value: the initializer of an assignment, or the identifier
 * of a shorthand member. Any other member, such as a method or accessor, is returned as is.
 */
function memberValue(property: ts.ObjectLiteralElementLike): ts.Node {
	return ts.isPropertyAssignment(property)
		? property.initializer
		: ts.isShorthandPropertyAssignment(property)
			? property.name
			: property;
}

/** Follows a spread expression to the object literal it spreads, when it is a `const` binding. */
export function spreadObject(
	cwd: string,
	file: string,
	expression: ts.Expression,
	parser: ts.SourceFileParser,
	depth: number,
): { file: string; object: ts.ObjectLiteralExpression } | undefined {
	const node = unwrapExpression(expression);

	if (depth > maxBindingDepth) {
		return;
	}

	if (ts.isObjectLiteralExpression(node)) {
		return { file, object: node };
	}

	if (ts.isIdentifier(node)) {
		const bound = boundDeclaration(cwd, file, node.text, parser, objectLiteral);
		return bound && { file: bound.file, object: bound.contract };
	}
}

/**
 * Follows a services factory expression to the contract type of its `defineServices` call.
 *
 * @param file - The module containing `expression`, relative to `cwd`
 * @returns The contract type node and the module it appears in
 */
function factoryContract(
	cwd: string,
	file: string,
	expression: ts.Expression,
	parser: ts.SourceFileParser,
	depth: number,
): { file: string; type: ts.TypeNode } | undefined {
	const node = unwrapExpression(expression);

	if (depth > maxBindingDepth) {
		return;
	}

	if (ts.isIdentifier(node)) {
		const bound = boundDeclaration(cwd, file, node.text, parser, (initializer) => initializer);
		return bound && factoryContract(cwd, bound.file, bound.contract, parser, depth + 1);
	}

	if (!ts.isCallExpression(node) || node.arguments.length !== 1) {
		return;
	}

	return helperContract(cwd, file, node.expression, parser, depth + 1, "defineServices");
}

/**
 * Follows a middleware helper, such as `defineCacheMiddleware`, to its
 * `createMiddleware<Requirements>()` call, or reads that call when the callee is the call itself.
 *
 * @param file - The module containing `callee`, relative to `cwd`
 * @returns The requirement type node and the module it appears in
 */
export function middlewareRequirement(
	cwd: string,
	file: string,
	callee: ts.Expression,
	parser: ts.SourceFileParser,
): { file: string; type: ts.TypeNode } | undefined {
	return helperContract(cwd, file, callee, parser, 0, "createMiddleware");
}

/**
 * Follows a helper, such as `defineAppServices`, to the `factory<Contract>()` call that made it:
 * `defineServices` for services, `createMiddleware` for middleware requirements.
 */
function helperContract(
	cwd: string,
	file: string,
	expression: ts.Expression,
	parser: ts.SourceFileParser,
	depth: number,
	factory: "defineServices" | "createMiddleware",
): { file: string; type: ts.TypeNode } | undefined {
	const node = unwrapExpression(expression);

	if (depth > maxBindingDepth) {
		return;
	}

	if (ts.isIdentifier(node)) {
		const bound = boundDeclaration(cwd, file, node.text, parser, (initializer) => initializer);
		return bound && helperContract(cwd, bound.file, bound.contract, parser, depth + 1, factory);
	}

	if (
		!ts.isCallExpression(node)
		|| callName(node) !== factory
		|| node.arguments.length > 0
		|| node.typeArguments?.length !== 1
	) {
		return;
	}

	return { file, type: node.typeArguments[0] as ts.TypeNode };
}

/**
 * Resolves a middleware's requirement interface and reads its service names. It follows the
 * rules of a service contract, and reports the same diagnostics.
 */
export function requirementContract(
	cwd: string,
	requirement: { file: string; type: ts.TypeNode },
	parser: ts.SourceFileParser,
): { services?: ServiceContractMetadata; diagnostics: Diagnostic[] } {
	return serviceContract(cwd, requirement.file, requirement.type, parser, {
		noun: "Service requirement",
		subject: "the requirement",
		usage: "createMiddleware<CacheRequirements>()",
	});
}

/**
 * Resolves a contract type to its exported declaration and reads its service names.
 *
 * @param kind - Names the type in messages, such as `Service contract` and `the contract`, and
 *   the call it is passed to
 */
function serviceContract(
	cwd: string,
	file: string,
	type: ts.TypeNode,
	parser: ts.SourceFileParser,
	kind: { noun: string; subject: string; usage: string },
): { services?: ServiceContractMetadata; diagnostics: Diagnostic[] } {
	const unresolved = (message: string, suggestion: string) => ({
		diagnostics: [
			{
				code: "ROUTA_SERVICES_CONTRACT_UNRESOLVED",
				severity: "error" as const,
				message,
				file,
				suggestion,
			},
		],
	});

	if (!ts.isTypeReferenceNode(type) || !ts.isIdentifier(type.typeName) || type.typeArguments) {
		return unresolved(
			`${kind.noun} ${type.getText()} is not a named interface or type.`,
			`Declare ${kind.subject} as an exported interface and pass its name: ${kind.usage}.`,
		);
	}

	const name = type.typeName.text;
	const declaration = typeDeclaration(cwd, file, name, parser);

	if (!declaration) {
		return unresolved(
			`${kind.noun} ${name} cannot be resolved to an interface or object type.`,
			`Declare ${kind.subject} in a project module, or import it through a relative import.`,
		);
	}

	if (!declaration.exportedName) {
		return unresolved(
			`${kind.noun} ${name} in ${declaration.file} is not exported, so generated types cannot reference it.`,
			`Export ${name} from ${declaration.file}.`,
		);
	}

	const members = contractMembers(declaration.node);

	if (members.problems.length > 0) {
		return {
			diagnostics: [
				{
					code: "ROUTA_SERVICES_CONTRACT_UNSUPPORTED",
					severity: "error",
					message: `${kind.noun} ${name} ${members.problems.join("; ")}.`,
					file: declaration.file,
					suggestion:
						"Declare each service as a required property with a plain name, directly in an interface or object type, without index signatures or extends.",
				},
			],
		};
	}

	return {
		services: {
			file: declaration.file,
			name: declaration.exportedName,
			names: members.names.sort(compareText),
		},
		diagnostics: [],
	};
}

type ContractDeclaration = ts.InterfaceDeclaration | ts.TypeAliasDeclaration;

type ResolvedContract = {
	file: string;
	node: ContractDeclaration;
	/** The name `file` exports the declaration under, when it exports it. */
	exportedName?: string | undefined;
};

/**
 * Finds the interface or type alias a module refers to by a name: its own declaration, or a named
 * import followed through re-exports.
 *
 * @param file - The module that uses the name, relative to `cwd`
 */
function typeDeclaration(
	cwd: string,
	file: string,
	name: string,
	parser: ts.SourceFileParser,
): ResolvedContract | undefined {
	const sourceFile = parseTypeScriptFile(join(cwd, file), parser);
	const node = localTypeDeclaration(sourceFile, name);

	if (node) {
		return { file, node, exportedName: localExportName(sourceFile, node) };
	}

	const source = namedImportMap(cwd, file, sourceFile).get(name);
	return source && exportedType(cwd, source.file, source.name, parser, new Set());
}

/** Finds the declaration a module exports under a name, through re-exports and `export *`. */
function exportedType(
	cwd: string,
	file: string,
	name: string,
	parser: ts.SourceFileParser,
	seen: Set<string>,
): ResolvedContract | undefined {
	const key = `${file}:${name}`;

	if (seen.has(key)) {
		return;
	}

	seen.add(key);
	const sourceFile = parseTypeScriptFile(join(cwd, file), parser);
	const declared = localTypeDeclaration(sourceFile, name);

	if (declared && localExportName(sourceFile, declared) === name) {
		return { file, node: declared, exportedName: name };
	}

	for (const statement of sourceFile.statements) {
		if (!ts.isExportDeclaration(statement)) {
			continue;
		}

		const target =
			statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)
				? resolveImportFile(cwd, file, statement.moduleSpecifier.text)
				: undefined;

		if (!statement.exportClause) {
			const found = target && exportedType(cwd, target, name, parser, seen);

			if (found) {
				return found;
			}

			continue;
		}

		const specifier = ts.isNamedExports(statement.exportClause)
			? statement.exportClause.elements.find((item) => item.name.text === name)
			: undefined;

		if (!specifier) {
			continue;
		}

		const localName = specifier.propertyName?.text ?? specifier.name.text;

		if (target) {
			return exportedType(cwd, target, localName, parser, seen);
		}

		const local = localTypeDeclaration(sourceFile, localName);

		if (local) {
			return { file, node: local, exportedName: name };
		}

		const source = namedImportMap(cwd, file, sourceFile).get(localName);
		return source && exportedType(cwd, source.file, source.name, parser, seen);
	}

	return undefined;
}

function localTypeDeclaration(
	sourceFile: ts.SourceFile,
	name: string,
): ContractDeclaration | undefined {
	return sourceFile.statements.find(
		(statement): statement is ContractDeclaration =>
			(ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement))
			&& statement.name.text === name,
	);
}

/** The name a module exports a local declaration under, if any. */
function localExportName(
	sourceFile: ts.SourceFile,
	declaration: ContractDeclaration,
): string | undefined {
	if (declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
		return declaration.name.text;
	}

	for (const statement of sourceFile.statements) {
		if (
			ts.isExportDeclaration(statement)
			&& !statement.moduleSpecifier
			&& statement.exportClause
			&& ts.isNamedExports(statement.exportClause)
		) {
			const specifier = statement.exportClause.elements.find(
				(item) => (item.propertyName?.text ?? item.name.text) === declaration.name.text,
			);

			if (specifier) {
				return specifier.name.text;
			}
		}
	}
}

/** Reads a contract's service names, and what keeps them from being a fixed required set. */
function contractMembers(declaration: ContractDeclaration): {
	names: string[];
	problems: string[];
} {
	const names = new Set<string>();
	const problems: string[] = [];
	let members: readonly ts.TypeElement[];

	if (declaration.typeParameters?.length) {
		problems.push("declares type parameters");
	}

	if (ts.isInterfaceDeclaration(declaration)) {
		// Interfaces that share a name in one module merge, so the contract holds all their members.
		const merged = declaration
			.getSourceFile()
			.statements.filter(
				(statement): statement is ts.InterfaceDeclaration =>
					ts.isInterfaceDeclaration(statement) && statement.name.text === declaration.name.text,
			);

		if (merged.some((item) => item.heritageClauses?.length)) {
			problems.push("extends another type");
		}

		members = merged.flatMap((item) => item.members);
	} else if (ts.isTypeLiteralNode(declaration.type)) {
		members = declaration.type.members;
	} else {
		return { names: [], problems: [...problems, "is not an object type"] };
	}

	for (const member of members) {
		if (!ts.isPropertySignatureDeclaration(member) && !ts.isMethodSignatureDeclaration(member)) {
			problems.push(
				ts.isIndexSignatureDeclaration(member)
					? "has an index signature"
					: `has an unsupported member \`${member.getText()}\``,
			);
			continue;
		}

		const name = propertyName(member.name);

		if (name === undefined) {
			problems.push(`has a computed service name \`${member.name.getText()}\``);
		} else if (member.postfixToken?.kind === ts.SyntaxKind.QuestionToken) {
			problems.push(`declares service "${name}" optional`);
		} else {
			names.add(name);
		}
	}

	return { names: [...names], problems };
}

/**
 * The type reference generated metadata uses for a contract: a type-only import from
 * `.routa/routes.gen.ts`, so nothing executes when the metadata loads.
 */
export function contractTypeReference(services: ServiceContractMetadata): string {
	const file = services.file.split(sep).join("/").replace(/\.ts$/, ".js");
	return `import(${JSON.stringify(`../${file}`)}).${services.name}`;
}
