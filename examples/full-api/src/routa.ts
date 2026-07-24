import { createLogger, createRouta } from "@routa-ts/core";

const logger = createLogger({
	sink: (event) => {
		console.log(JSON.stringify({ app: "full-api", ...event }));
	},
});

export default createRouta({
	host: "127.0.0.1",
	port: 3000,
	logger: process.env.ROUTA_DEMO_LOGGER === "off" ? false : logger,
	lifecycleHeaders: true,
});
