import { z } from "zod";

export const ShowcaseItemParams = z.object({
	itemId: z.string(),
});

export const ShowcaseItemQuery = z.object({
	verbose: z.stringbool().optional(),
});

export const ShowcaseItem = z.object({
	id: z.string(),
	name: z.string(),
	active: z.boolean(),
	metadata: z.record(z.string(), z.string()),
	note: z.string().nullable(),
});

export const ShowcaseNotFound = z.object({
	message: z.string(),
	itemId: z.string(),
});

export const ReplaceShowcaseItemBody = z.object({
	name: z.string().min(1),
	active: z.boolean(),
});
