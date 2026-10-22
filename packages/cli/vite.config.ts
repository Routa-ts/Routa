import { defineConfig } from "vite-plus";
import frameworkConfig from "../../vite.config.js";

export default defineConfig({
	lint: frameworkConfig.lint,
	fmt: frameworkConfig.fmt,
	pack: {
		entry: ["src/index.ts", "src/runtime.ts"],
		fixedExtension: false,
		target: "node24",
		dts: { generator: "tsgo", sourcemap: false },
		sourcemap: false,
		deps: {
			neverBundle: [
				"@hono/node-server",
				"@routa-ts/core",
				/^@routa-ts\/core\//,
				"tsx",
				"typescript",
				/^typescript\//,
				"yaml",
			],
		},
	},
});
