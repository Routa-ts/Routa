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
						// The CLI bundles the creator and reads core declarations.
						{ pattern: "packages/{core,create-routa-ts}/dist/**", base: "workspace" },
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
			thresholds: { branches: 81 },
		},
	},
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
