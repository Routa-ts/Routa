import { defineConfig } from "vite-plus";
import frameworkConfig from "../../vite.config.js";

export default defineConfig({
	run: {
		tasks: {
			build: {
				command: "vp pack",
				cache: {
					input: [
						"src/**",
						"!src/**/*.test.ts",
						"package.json",
						"tsconfig.json",
						"vite.config.ts",
						{
							pattern:
								"{vite.config.ts,tsconfig.base.json,package.json,pnpm-lock.yaml,pnpm-workspace.yaml,.npmrc,.nvmrc}",
							base: "workspace",
						},
					],
					output: ["dist/**"],
					env: ["CI"],
				},
			},
		},
	},
	test: {
		coverage: {
			provider: "v8",
			include: ["src/**/*.ts"],
			exclude: ["src/**/*.test.ts"],
			reporter: ["text-summary"],
			thresholds: { branches: 100 },
		},
	},
	lint: frameworkConfig.lint,
	fmt: frameworkConfig.fmt,
	// Consumers run and bundle the source. The build emits only the declarations core's own
	// declaration build inlines, which tsgo cannot emit for a file outside core's project.
	pack: {
		entry: ["src/index.ts"],
		fixedExtension: false,
		target: "node24",
		dts: { generator: "tsgo", sourcemap: false, emitDtsOnly: true },
		sourcemap: false,
	},
});
