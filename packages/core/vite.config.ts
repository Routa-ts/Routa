import { defineConfig } from "vite-plus";
import frameworkConfig from "../../vite.config.js";

export default defineConfig({
	run: {
		tasks: {
			build: {
				command: "vp pack",
				dependsOn: [{ task: "build", from: ["dependencies", "devDependencies"] }],
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
			// One point under the measured branch coverage, because a few branches depend on how
			// the tests are launched. Raise it when tests improve.
			thresholds: { branches: 92 },
		},
	},
	lint: frameworkConfig.lint,
	fmt: frameworkConfig.fmt,
	pack: {
		entry: [
			"src/index.ts",
			"src/hono.ts",
			"src/logger.ts",
			"src/query/helpers.ts",
			"src/testing.ts",
		],
		unbundle: true,
		fixedExtension: false,
		target: "node24",
		dts: { generator: "tsgo", sourcemap: false },
		sourcemap: false,
		deps: { neverBundle: true },
	},
});
