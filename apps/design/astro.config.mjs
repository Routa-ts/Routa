// @ts-check
import starlight from "@astrojs/starlight";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";

// Parallel design-review app — not the public docs site.
// Share this app to review identity options without shipping them to routa-ts.dev.
export default defineConfig({
	site: "https://design.routa-ts.dev",
	server: {
		port: 4322,
	},
	integrations: [
		starlight({
			title: "Routa Design Lab",
			description:
				"Parallel identity review for Routa docs and web — five system-design options using the same Starlight components.",
			social: [{ icon: "github", label: "GitHub", href: "https://github.com/Routa-ts/Routa" }],
			head: [
				{
					tag: "link",
					attrs: {
						rel: "stylesheet",
						href: "https://fonts.googleapis.com/css2?family=Fira+Code:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&family=JetBrains+Mono:wght@400;500;600;700&family=Newsreader:ital,opsz,wght@0,6..72,400;0,6..72,600;0,6..72,700;1,6..72,400&family=Outfit:wght@400;500;600;700&family=Sora:wght@400;500;600;700&family=Space+Grotesk:wght@400;500;600;700&family=Space+Mono:wght@400;700&display=swap",
					},
				},
			],
			sidebar: [
				{
					label: "Review",
					items: [
						{ label: "Overview", link: "/" },
						{ label: "Landings hub", link: "/landings/" },
					],
				},
				{
					label: "Landing options",
					items: [
						{ label: "01 · Contract", link: "/landings/contract/" },
						{ label: "02 · Walk", link: "/landings/walk/" },
						{ label: "03 · Check", link: "/landings/check/" },
						{ label: "04 · Peer", link: "/landings/peer/" },
						{ label: "05 · Schematic", link: "/landings/schematic/" },
					],
				},
				{
					label: "Identity archive",
					collapsed: true,
					items: [
						{ label: "Option A · Compass", slug: "option-compass" },
						{ label: "Option B · Ledger", slug: "option-ledger" },
						{ label: "Option C · Trace", slug: "option-trace" },
						{ label: "Option D · Atlas", slug: "option-atlas" },
						{ label: "Option E · Lattice", slug: "option-lattice" },
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
