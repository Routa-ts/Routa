import { defineConfig } from "vite-plus";

const frameworkIgnores = [
	"**/node_modules/**",
	"**/dist/**",
	"**/coverage/**",
	"**/.routa/**",
	"**/.turbo/**",
	".dex/**",
	"apps/**",
	"examples/**",
	"docs/**",
	".github/**",
];

export default defineConfig({
	run: {
		// Keep publishing, generation, server checks, and tests uncached.
		cache: { scripts: false, tasks: true },
		tasks: {
			compile: {
				command: "pnpm --filter './packages/*' build",
				cache: {
					input: [
						"packages/*/src/**",
						"!packages/*/src/**/*.test.ts",
						"packages/*/package.json",
						"packages/*/tsconfig.json",
						"packages/*/vite.config.ts",
						"tsconfig.base.json",
						"package.json",
						"pnpm-lock.yaml",
						"pnpm-workspace.yaml",
						"vite.config.ts",
						".npmrc",
						".nvmrc",
					],
					output: ["packages/*/dist/**"],
					env: ["CI"],
				},
			},
			unit: {
				command: "vp run --filter './packages/*' test",
				dependsOn: ["compile"],
				cache: false,
			},
		},
	},
	lint: {
		ignorePatterns: frameworkIgnores,
		plugins: ["typescript", "unicorn", "oxc", "node", "import", "vitest", "promise"],
		options: {
			typeAware: true,
			typeCheck: true,
		},
		rules: {
			"no-console": "warn",
			"no-debugger": "error",
			"no-eval": "error",
			"no-unused-vars": "error",
			"typescript/ban-ts-comment": [
				"error",
				{ "ts-ignore": true, "ts-nocheck": true, "ts-expect-error": false },
			],
			"typescript/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
			"typescript/consistent-type-exports": "warn",
			"typescript/no-floating-promises": "error",
			"typescript/no-misused-promises": "error",
			"unicorn/prefer-node-protocol": "error",
			"vitest/no-focused-tests": "error",
			"vitest/no-disabled-tests": "error",
		},
		overrides: [
			{
				files: ["**/*.test.ts"],
				rules: { "no-console": "off" },
			},
		],
	},
	fmt: {
		ignorePatterns: [
			...frameworkIgnores,
			"**/CHANGELOG.md",
			"biome.json",
			"pnpm-lock.yaml",
			"skills-lock.json",
		],
		useTabs: true,
		tabWidth: 2,
		printWidth: 100,
		singleQuote: false,
		semi: true,
		trailingComma: "all",
		experimentalOperatorPosition: "start",
		sortPackageJson: false,
		embeddedLanguageFormatting: "off",
	},
});
