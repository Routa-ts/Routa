import { defineConfig } from "vite-plus";

const generatedIgnores = [
	"**/node_modules/**",
	"**/dist/**",
	"**/coverage/**",
	"**/.routa/**",
	"**/.turbo/**",
	".dex/**",
	"**/.astro/**",
];

export default defineConfig({
	run: {
		// Keep publishing, generation, server checks, and tests uncached.
		cache: { scripts: false, tasks: true },
		tasks: {
			compile: {
				command: "vp run --filter './packages/*' build",
				cache: false,
			},
			unit: {
				command: "vp run --filter './packages/*' test",
				dependsOn: ["compile"],
				cache: false,
			},
		},
	},
	lint: {
		ignorePatterns: generatedIgnores,
		jsPlugins: [
			{ name: "dependency-checks", specifier: "eslint-plugin-import-x" },
			"eslint-plugin-no-secrets",
		],
		plugins: ["typescript", "unicorn", "oxc", "node", "import", "vitest", "promise"],
		options: {
			typeAware: true,
			typeCheck: true,
		},
		rules: {
			"no-console": "warn",
			"no-debugger": "error",
			"no-eval": "error",
			"no-secrets/no-secrets": ["error", { tolerance: 4.5 }],
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
				files: ["packages/*/src/**/*.ts"],
				excludeFiles: ["**/*.test.ts"],
				rules: { "dependency-checks/no-extraneous-dependencies": "error" },
			},
			{
				files: ["**/*.test.ts"],
				rules: { "no-console": "off", "no-secrets/no-secrets": "off" },
			},
		],
	},
	fmt: {
		ignorePatterns: [...generatedIgnores, "pnpm-lock.yaml", "skills-lock.json"],
		// The pinned Astro formatter drops frontmatter comments unless this is set.
		astro: { skipFrontmatter: true },
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
