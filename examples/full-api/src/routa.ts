import { createRouta } from "@routa-ts/core";
import { createFullApiLogger } from "./logger.js";

const logger = process.env.ROUTA_DEMO_LOGGER === "off" ? false : createFullApiLogger();

export default createRouta({
	host: "127.0.0.1",
	port: 3000,
	logger,
	lifecycleHeaders: true,
});
