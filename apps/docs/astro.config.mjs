// @ts-check
import starlight from "@astrojs/starlight";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

// https://astro.build/config
export default defineConfig({
	site: "https://routa-ts.dev",
	integrations: [
		starlight({
			title: "Routa",
			description: "Schema-first, OpenAPI-aware REST framework for new TypeScript APIs.",
			editLink: {
				baseUrl: "https://github.com/Routa-ts/Routa/edit/main/apps/docs/",
			},
			social: [{ icon: "github", label: "GitHub", href: "https://github.com/Routa-ts/Routa" }],
			sidebar: [
				{
					label: "Start",
					items: [
						{ label: "Overview", link: "/" },
						{ label: "Quickstart", slug: "start/quickstart" },
						{ label: "v0 Scope & Status", slug: "start/v0-scope" },
						{ label: "Why Routa", slug: "start/why-routa" },
					],
				},
				{
					label: "Getting Started",
					items: [
						{ label: "Installation", slug: "getting-started/installation" },
						{ label: "Create a project", slug: "getting-started/create-project" },
						{ label: "Project anatomy", slug: "getting-started/project-anatomy" },
						{ label: "First route", slug: "getting-started/first-route" },
					],
				},
				{
					label: "Concepts",
					items: [
						{ label: "Route contracts", slug: "concepts/route-contracts" },
						{ label: "Schemas", slug: "concepts/schemas" },
						{ label: "OpenAPI", slug: "concepts/openapi" },
						{ label: "Middleware", slug: "concepts/middleware" },
						{ label: "Generated files", slug: "concepts/generated-files" },
					],
				},
				{
					label: "Guides",
					items: [
						{ label: "Scaffold from OpenAPI", slug: "guides/openapi-scaffold" },
						{ label: "Regenerate safely", slug: "guides/regeneration" },
						{ label: "Check and build", slug: "guides/check-build" },
						{ label: "Run and start", slug: "guides/run-start" },
					],
				},
				{
					label: "Reference",
					items: [
						{ label: "CLI", slug: "reference/cli" },
						{ label: "Core", slug: "reference/core" },
						{ label: "Runtime behavior", slug: "reference/runtime-behavior" },
						{ label: "Diagnostics", slug: "reference/diagnostics" },
					],
				},
				{
					label: "Examples",
					items: [
						{ label: "Basic API", slug: "examples/basic-api" },
						{ label: "Full API", slug: "examples/full-api" },
					],
				},
				{
					label: "Community",
					items: [
						{ label: "Contributing", slug: "community/contributing" },
						{ label: "Security", slug: "community/security" },
					],
				},
			],
			customCss: ["./src/styles/global.css"],
		}),
	],
	vite: {
		plugins: [tailwindcss()],
	},
});
