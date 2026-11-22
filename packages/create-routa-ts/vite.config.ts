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
			// Tests and typechecks read workspace packages through node_modules, so build them first.
			test: {
				command: "vp test run --coverage",
				dependsOn: [{ task: "build", from: ["dependencies", "devDependencies"] }],
				cache: false,
			},
			typecheck: {
				command: [
					"vp exec tsc -p tsconfig.json --noEmit",
					"vp exec tsc -p tsconfig.test.json --noEmit",
				],
				dependsOn: [{ task: "build", from: ["dependencies", "devDependencies"] }],
				cache: false,
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
			thresholds: { branches: 60 },
		},
	},
	lint: frameworkConfig.lint,
	fmt: frameworkConfig.fmt,
	pack: {
		entry: ["src/index.ts", "src/cli.ts"],
		fixedExtension: false,
		target: "node24",
		dts: { generator: "tsgo", sourcemap: false },
		sourcemap: false,
	},
});
