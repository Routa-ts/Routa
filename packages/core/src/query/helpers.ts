import { z } from "zod";

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

export function Fields<const TFields extends readonly [string, ...string[]]>(fields: TFields) {
	return z
		.string()
		.transform((value) => value.split(","))
		.pipe(z.array(z.enum(fields)));
}
