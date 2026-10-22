import { defineConfig } from "vite-plus";
import frameworkConfig from "../../vite.config.js";

export default defineConfig({
	lint: frameworkConfig.lint,
	fmt: frameworkConfig.fmt,
	pack: {
		entry: ["src/index.ts", "src/hono.ts", "src/logger.ts", "src/query/helpers.ts"],
		unbundle: true,
		fixedExtension: false,
		target: "node24",
		dts: { generator: "tsgo", sourcemap: false },
		sourcemap: false,
		deps: { neverBundle: true },
	},
});
