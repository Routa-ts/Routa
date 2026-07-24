import { createRoute, createRouteRoot } from "@routa-ts/core";
import { z } from "zod";
import {
	ReplaceShowcaseItemBody,
	ShowcaseItem,
	ShowcaseItemParams,
	ShowcaseItemQuery,
	ShowcaseNotFound,
} from "./schemas.js";

const route = createRouteRoot("/showcase/:itemId");

export default route({
	get: createRoute({
		input: {
			params: ShowcaseItemParams,
			query: ShowcaseItemQuery,
		},
		responses: {
			success: {
				status: 200,
				schema: ShowcaseItem,
			},
			notFound: {
				status: 404,
				schema: ShowcaseNotFound,
			},
		},
		run: ({ input }) => {
			if (input.params.itemId === "missing") {
				return {
					type: "notFound",
					data: {
						message: "Showcase item was not found.",
						itemId: input.params.itemId,
					},
				};
			}

			return {
				type: "success",
				data: {
					id: input.params.itemId,
					name: input.query.verbose ? "Verbose showcase item" : "Showcase item",
					active: true,
					metadata: { source: "route-owned-result" },
					note: null,
				},
			};
		},
	}),
	put: createRoute({
		input: {
			params: ShowcaseItemParams,
			body: ReplaceShowcaseItemBody,
		},
		responses: {
			success: {
				status: 200,
				schema: ShowcaseItem,
			},
		},
		run: ({ input }) => ({
			type: "success",
			data: {
				id: input.params.itemId,
				name: input.body.name,
				active: input.body.active,
				metadata: { replacedBy: "PUT" },
				note: null,
			},
		}),
	}),
	head: createRoute({
		input: {
			params: ShowcaseItemParams,
		},
		responses: {
			success: {
				status: 204,
				schema: z.null(),
			},
		},
		run: () => ({ type: "success", data: null }),
	}),
});
