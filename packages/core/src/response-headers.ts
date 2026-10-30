import type { z } from "zod";
import { InvalidHandlerOutputError } from "./handler-output-error.js";

/** What an outcome's `headers` result field holds after structural checks: declared, defined values. */
export type HeaderValues = Record<string, unknown>;

/**
 * Header names Routa owns on every response, so no outcome can declare them. The declaration
 * types derive their reserved names from this list.
 */
export const reservedHeaders = [
	"content-type",
	"content-length",
	"transfer-encoding",
	"connection",
	"set-cookie",
] as const;

const reservedHeaderNames: ReadonlySet<string> = new Set(reservedHeaders);

const tokenPattern = /^[!#$%&'*+\-.^_`|~0-9a-z]+$/;
const safeValuePattern = /^[\t\x20-\x7e\x80-\xff]*$/;
const valueTypes = "string, number, or boolean";

type HeaderOutcome = { headers?: unknown };

/**
 * Describes why a header declaration is invalid, or returns `undefined` when it is valid.
 *
 * TypeScript and `routa check` report the same rules earlier. This keeps hand-built contracts honest.
 *
 * @param headers - The outcome's `headers` declaration
 * @param lifecycleOwned - Header names the response lifecycle owns for this route
 */
export function headerDeclarationProblem(
	headers: unknown,
	lifecycleOwned: ReadonlySet<string>,
): string | undefined {
	const shape = declaredShape(headers);

	if (!shape) {
		return "declares headers that are not a z.object({ ... }) schema.";
	}

	const seen = new Map<string, string>();

	for (const name of Object.keys(shape)) {
		const earlier = seen.get(name.toLowerCase());

		if (earlier !== undefined) {
			return `declares headers "${earlier}" and "${name}", which differ only in case. A header has one owner, so declare it once in lowercase.`;
		}

		seen.set(name.toLowerCase(), name);
	}

	for (const [name, schema] of Object.entries(shape)) {
		const lower = name.toLowerCase();

		if (!tokenPattern.test(lower)) {
			return `declares "${name}", which is not a valid header name.`;
		}

		if (lower === "set-cookie") {
			return `declares header "${name}", but Routa owns Set-Cookie. Declare response cookies as cookies, not as a header.`;
		}

		if (reservedHeaderNames.has(lower)) {
			return `declares header "${name}", but Routa owns ${lower}. Remove it from headers.`;
		}

		if (lifecycleOwned.has(lower)) {
			return `declares header "${name}", but the route's lifecycle headers own it. Remove it, or turn lifecycle headers off.`;
		}

		if (name !== lower) {
			return `declares header "${name}". Declare header names in lowercase ("${lower}").`;
		}

		if (!isScalarSchema(schema)) {
			return `declares header "${name}" with a value that is not a ${valueTypes} (or a literal or enum of them).`;
		}
	}

	return undefined;
}

/**
 * Resolves the headers a handler result writes for one outcome.
 *
 * Runs in every response validation mode: only declared names, every required header present, and
 * no case collisions or reserved names. `undefined` values count as absent.
 *
 * @returns The defined header values, keyed by declared (lowercase) name
 * @throws {InvalidHandlerOutputError} When the result breaks the outcome's header declaration
 */
export function resolveHeaders(
	type: string,
	outcome: HeaderOutcome,
	written: unknown,
): HeaderValues {
	const shape = declaredShape(outcome.headers);

	if (written === undefined) {
		missingHeaders(type, shape, {});
		return {};
	}

	if (!shape) {
		throw new InvalidHandlerOutputError(
			`Response type "${type}" declares no headers and cannot return headers.`,
		);
	}

	if (typeof written !== "object" || written === null || Array.isArray(written)) {
		throw new InvalidHandlerOutputError(
			`Response type "${type}" returned headers that are not an object.`,
		);
	}

	if (
		Object.getPrototypeOf(written) !== Object.prototype
		&& Object.getPrototypeOf(written) !== null
	) {
		throw new InvalidHandlerOutputError(
			`Response type "${type}" returned headers that are not a plain object.`,
		);
	}

	const values: HeaderValues = {};
	const seen = new Map<string, string>();

	for (const [name, value] of Object.entries(written)) {
		const lower = name.toLowerCase();
		const earlier = seen.get(lower);

		if (earlier !== undefined) {
			throw new InvalidHandlerOutputError(
				`Response type "${type}" wrote headers "${earlier}" and "${name}", which name one header in different case.`,
			);
		}

		seen.set(lower, name);

		if (!Object.hasOwn(shape, name)) {
			throw new InvalidHandlerOutputError(undeclaredMessage(type, name, lower, shape));
		}

		if (value !== undefined) {
			values[name] = value;
		}
	}

	missingHeaders(type, shape, values);
	return values;
}

/**
 * Serializes header values to strings, in declaration order.
 *
 * Strings must be safe field values, numbers finite, and booleans `true` or `false`. Runs in every
 * mode so no value reaches the wire that could split or corrupt the response.
 */
export function serializeHeaders(
	type: string,
	outcome: HeaderOutcome,
	values: HeaderValues,
): Array<[string, string]> {
	const shape = declaredShape(outcome.headers) ?? {};

	return Object.keys(shape).flatMap((name) =>
		Object.hasOwn(values, name) ? [[name, serializeValue(type, name, values[name])]] : [],
	);
}

/**
 * The headers the response lifecycle owns for a route, keyed by lowercase name.
 *
 * Empty unless lifecycle headers are enabled and the route declares a `deprecation`.
 */
export function lifecycleHeaders(
	deprecation: { sunset?: string; replacement?: string } | undefined,
	enabled: boolean | undefined,
): Record<string, string> {
	if (!enabled || !deprecation) return {};
	return {
		deprecation: "true",
		...(deprecation.sunset ? { sunset: deprecation.sunset } : {}),
		...(deprecation.replacement
			? { link: `<${deprecation.replacement}>; rel="successor-version"` }
			: {}),
	};
}

/**
 * The header names the lifecycle owns for a route: `deprecation` and `sunset` always, and `link`
 * when the deprecation names a replacement.
 */
export function lifecycleOwnedHeaders(
	deprecation: { replacement?: string } | undefined,
	enabled: boolean | undefined,
): ReadonlySet<string> {
	if (!enabled || !deprecation) return new Set();
	return new Set(["deprecation", "sunset", ...(deprecation.replacement ? ["link"] : [])]);
}

/** The Zod object shape of a header declaration, or `undefined` when there is none or it is not an object. */
export function declaredShape(headers: unknown): Record<string, z.ZodType> | undefined {
	const def = zodDef(headers);

	if (def?.type !== "object" || typeof def.shape !== "object" || def.shape === null) {
		return undefined;
	}

	return def.shape as Record<string, z.ZodType>;
}

function missingHeaders(
	type: string,
	shape: Record<string, z.ZodType> | undefined,
	values: HeaderValues,
): void {
	for (const [name, schema] of Object.entries(shape ?? {})) {
		if (!Object.hasOwn(values, name) && !isOptional(schema)) {
			throw new InvalidHandlerOutputError(
				`Response type "${type}" declares header "${name}" and requires it.`,
			);
		}
	}
}

function undeclaredMessage(
	type: string,
	name: string,
	lower: string,
	shape: Record<string, z.ZodType>,
): string {
	if (lower === "set-cookie") {
		return `Response type "${type}" wrote header "${name}", but Routa owns Set-Cookie. Response cookies are not headers.`;
	}

	if (reservedHeaderNames.has(lower)) {
		return `Response type "${type}" wrote header "${name}", but Routa owns ${lower} and sets it itself.`;
	}

	if (Object.hasOwn(shape, lower)) {
		return `Response type "${type}" wrote header "${name}", which differs only in case from declared header "${lower}". Use the declared lowercase name.`;
	}

	return `Response type "${type}" wrote header "${name}", which it does not declare.`;
}

function serializeValue(type: string, name: string, value: unknown): string {
	if (typeof value === "string") {
		if (!safeValuePattern.test(value) || value !== value.trim()) {
			throw new InvalidHandlerOutputError(
				`Response type "${type}" wrote header "${name}" with a value that is not a safe header field value.`,
			);
		}

		return value;
	}

	if (typeof value === "number" && Number.isFinite(value)) {
		return String(value);
	}

	if (typeof value === "boolean") {
		return String(value);
	}

	throw new InvalidHandlerOutputError(
		`Response type "${type}" wrote header "${name}" with a value that is not a ${valueTypes}.`,
	);
}

function isOptional(schema: z.ZodType): boolean {
	return (schema as { _zod?: { optin?: string } })._zod?.optin === "optional";
}

type ZodDef = { type?: string; [key: string]: unknown };

function zodDef(schema: unknown): ZodDef | undefined {
	return (schema as { _zod?: { def?: ZodDef } } | null | undefined)?._zod?.def;
}

/**
 * Whether a schema accepts only strings, numbers, and booleans (optionally absent) and returns
 * them unchanged. Wrappers and compositions count when everything inside them does; anything that
 * rewrites a value in the declaration, such as a transform, a default, or coercion, does not.
 * Same-type rewrites like `.trim()` are not visible here; response validation catches them.
 */
export function isScalarSchema(schema: unknown): boolean {
	const def = zodDef(schema);

	if (!def || def.coerce === true) {
		return false;
	}

	switch (def.type) {
		case "string":
		case "number":
		case "boolean":
		case "enum":
			return true;
		case "literal":
			return (def.values as unknown[]).every(
				(value) =>
					typeof value === "string" || typeof value === "number" || typeof value === "boolean",
			);
		case "optional":
		case "nonoptional":
		case "readonly":
			return isScalarSchema(def.innerType);
		case "union":
			return (def.options as unknown[]).every(isScalarSchema);
		case "intersection":
			return isScalarSchema(def.left) && isScalarSchema(def.right);
		case "pipe":
			return isScalarSchema(def.in) && isScalarSchema(def.out);
		default:
			return false;
	}
}
