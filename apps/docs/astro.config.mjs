// @ts-check
import starlight from "@astrojs/starlight";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig, fontProviders } from "astro/config";

const site = "https://routa-ts.dev";
const ogImage = new URL("/og.png", site).href;

// https://astro.build/config
export default defineConfig({
	site,
	trailingSlash: "always",
	// Self-hosted and preloaded. `block` waits for the font (briefly, it is preloaded) so
	// WebKit browsers never flash the fallback; the metric-matched fallback still applies
	// if the font fails to load.
	fonts: [
		{
			provider: fontProviders.google(),
			name: "Overpass",
			cssVariable: "--font-overpass",
			// Variable font: one file covers the whole weight range.
			weights: ["400 900"],
			styles: ["normal"],
			display: "block",
			subsets: ["latin"],
			fallbacks: ["ui-sans-serif", "system-ui", "sans-serif"],
		},
		{
			provider: fontProviders.google(),
			name: "Overpass Mono",
			cssVariable: "--font-overpass-mono",
			weights: ["400 700"],
			styles: ["normal"],
			display: "block",
			subsets: ["latin"],
			fallbacks: ["ui-monospace", "monospace"],
		},
	],
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
						href: "https://fonts.googleapis.com/css2?family=Overpass:wght@400;600;700;800;900&family=Overpass+Mono:wght@400;700&display=swap",
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
						{ label: "Authentication", slug: "docs/concepts/authentication" },
						{ label: "Services", slug: "docs/concepts/services" },
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
						{ label: "Custom credential schemes", slug: "docs/guides/custom-credential-schemes" },
						{ label: "Logging", slug: "docs/guides/logging" },
						{ label: "Run and start", slug: "docs/guides/run-start" },
						{ label: "Deploy", slug: "docs/guides/deploy" },
						{ label: "API evolution", slug: "docs/guides/api-evolution" },
						{ label: "Migrate response contracts", slug: "docs/guides/migrate-response-contracts" },
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
			components: {
				SiteTitle: "./src/components/SiteTitle.astro",
			},
			// One navy code theme in both color modes, matching the landing page.
			expressiveCode: {
				themes: ["github-dark-default"],
				styleOverrides: {
					codeBackground: "#16203A",
					borderColor: "#16203A",
					borderRadius: "12px",
					codeFontFamily: "var(--sl-font-mono)",
					uiFontFamily: "var(--sl-font-mono)",
					frames: {
						editorTabBarBackground: "#16203A",
						editorActiveTabBackground: "#16203A",
						editorActiveTabIndicatorTopColor: "transparent",
						editorActiveTabIndicatorBottomColor: "transparent",
						editorTabBarBorderBottomColor: "#2A3554",
						terminalTitlebarBackground: "#16203A",
						terminalTitlebarBorderBottomColor: "#2A3554",
						terminalBackground: "#16203A",
						frameBoxShadowCssValue: "none",
					},
				},
			},
			customCss: ["./src/styles/global.css"],
		}),
	],
	vite: {
		plugins: [tailwindcss()],
	},
});
