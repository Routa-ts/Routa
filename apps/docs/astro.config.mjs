// @ts-check
import starlight from "@astrojs/starlight";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

const site = "https://routa-ts.dev";
const ogImage = new URL("/og.png", site).href;

// https://astro.build/config
export default defineConfig({
	site,
	trailingSlash: "always",
	integrations: [
		starlight({
			title: "Routa",
			description: "Schema-first, OpenAPI-aware REST framework for new TypeScript APIs.",
			editLink: {
				baseUrl: "https://github.com/Routa-ts/Routa/edit/main/apps/docs/",
			},
			social: [{ icon: "github", label: "GitHub", href: "https://github.com/Routa-ts/Routa" }],
			head: [
				// Starlight emits og:title/description/url but no image or Twitter card.
				{
					tag: "meta",
					attrs: { property: "og:image", content: ogImage },
				},
				{
					tag: "meta",
					attrs: { property: "og:image:width", content: "1200" },
				},
				{
					tag: "meta",
					attrs: { property: "og:image:height", content: "630" },
				},
				{
					tag: "meta",
					attrs: {
						property: "og:image:alt",
						content: "Routa — filesystem routes with contracts. Schema-first REST for TypeScript.",
					},
				},
				{
					tag: "meta",
					attrs: { name: "twitter:card", content: "summary_large_image" },
				},
				{
					tag: "meta",
					attrs: { name: "twitter:image", content: ogImage },
				},
				{
					tag: "link",
					attrs: {
						rel: "preconnect",
						href: "https://fonts.googleapis.com",
					},
				},
				{
					tag: "link",
					attrs: {
						rel: "preconnect",
						href: "https://fonts.gstatic.com",
						crossorigin: true,
					},
				},
				{
					tag: "link",
					attrs: {
						rel: "stylesheet",
						// biome-ignore lint/security/noSecrets: Google Fonts stylesheet URL, not a secret
						href: "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600;700&family=Space+Mono:wght@400;700&display=swap",
					},
				},
			],
			sidebar: [
				{
					label: "Start",
					items: [
						{ label: "Overview", slug: "docs" },
						{ label: "Quickstart", slug: "docs/start/quickstart" },
						{ label: "v0 Scope & Status", slug: "docs/start/v0-scope" },
						{ label: "Why Routa", slug: "docs/start/why-routa" },
					],
				},
				{
					label: "Getting Started",
					items: [
						{ label: "Installation", slug: "docs/getting-started/installation" },
						{ label: "Create a project", slug: "docs/getting-started/create-project" },
						{ label: "Project anatomy", slug: "docs/getting-started/project-anatomy" },
						{ label: "First route", slug: "docs/getting-started/first-route" },
					],
				},
				{
					label: "Concepts",
					items: [
						{ label: "Route contracts", slug: "docs/concepts/route-contracts" },
						{ label: "Routing", slug: "docs/concepts/routing" },
						{ label: "Schemas", slug: "docs/concepts/schemas" },
						{ label: "OpenAPI", slug: "docs/concepts/openapi" },
						{ label: "Middleware", slug: "docs/concepts/middleware" },
						{ label: "Generated files", slug: "docs/concepts/generated-files" },
					],
				},
				{
					label: "Guides",
					items: [
						{ label: "Scaffold from OpenAPI", slug: "docs/guides/openapi-scaffold" },
						{ label: "Regenerate safely", slug: "docs/guides/regeneration" },
						{ label: "Check and build", slug: "docs/guides/check-build" },
						{ label: "Testing", slug: "docs/guides/testing" },
						{ label: "Run and start", slug: "docs/guides/run-start" },
						{ label: "Deploy", slug: "docs/guides/deploy" },
						{ label: "API evolution", slug: "docs/guides/api-evolution" },
					],
				},
				{
					label: "Reference",
					items: [
						{ label: "CLI", slug: "docs/reference/cli" },
						{ label: "Core", slug: "docs/reference/core" },
						{ label: "Configuration", slug: "docs/reference/configuration" },
						{ label: "Runtime behavior", slug: "docs/reference/runtime-behavior" },
						{ label: "Diagnostics", slug: "docs/reference/diagnostics" },
					],
				},
				{
					label: "Examples",
					items: [
						{ label: "Basic API", slug: "docs/examples/basic-api" },
						{ label: "Full API", slug: "docs/examples/full-api" },
					],
				},
				{
					label: "Community",
					items: [
						{ label: "Contributing", slug: "docs/community/contributing" },
						{ label: "Security", slug: "docs/community/security" },
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
