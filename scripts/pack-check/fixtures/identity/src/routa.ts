import { createRouta } from "@routa-ts/core";

export default createRouta({
	port: 3000,
	logger: process.env.SMOKE_LOGGER === "off" ? false : undefined,
	correlation: true,
	onRequestError: (error, diagnostic) => {
		console.error(
			JSON.stringify({
				reported: diagnostic.code,
				requestId: diagnostic.requestId,
				correlationId: diagnostic.correlationId,
				original: error instanceof Error ? error.message : String(error),
			}),
		);
	},
});
