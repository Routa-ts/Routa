import { z } from "zod";

/**
 * Parses a sort field string into a field and direction.
 *
 * @param fields - Allowed field names
 * @returns A schema that parses a valid sort string into an object with `field` and `direction`
 */
export function Sort<const TFields extends readonly [string, ...string[]]>(fields: TFields) {
	const allowed = new Set<string>(fields);

	return z
		.string()
		.refine((value) => {
			const field = value.startsWith("-") ? value.slice(1) : value;
			return field.length > 0 && allowed.has(field);
		})
		.transform((value) => {
			const direction = value.startsWith("-") ? "desc" : "asc";
			const field = value.startsWith("-") ? value.slice(1) : value;

			return {
				field: field as TFields[number],
				direction,
			};
		});
}

/**
 * Parses a comma-separated list of fields.
 *
 * @param fields - The set of allowed field names
 * @returns A schema that produces an array of allowed field names
 */
export function Fields<const TFields extends readonly [string, ...string[]]>(fields: TFields) {
	return z
		.string()
		.transform((value) => value.split(","))
		.pipe(z.array(z.enum(fields)));
}
