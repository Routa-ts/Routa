import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type CreateProjectResult = {
	projectDir: string;
	files: string[];
};

export type CreateProjectOptions = {
	openApi?: boolean;
	routaVersion?: string;
};

export function createProject(
	targetDir: string,
	cwd = process.cwd(),
	options: CreateProjectOptions = {},
): CreateProjectResult {
	const projectDir = resolve(cwd, targetDir);

	if (existsSync(projectDir)) {
		throw new Error(`Target directory already exists: ${targetDir}`);
	}

	const files = new Map<string, string>([
		[".gitignore", gitignore()],
		[".vscode/settings.json", vscodeSettings()],
		["README.md", readme(targetDir)],
		["biome.json", biomeJson()],
		["package.json", packageJson(targetDir, options.routaVersion ?? "latest")],
		["src/routa.ts", routaSource()],
		["tsconfig.json", tsconfigJson()],
		["src/routes/status/route.ts", statusRouteSource()],
		["src/routes/status/schemas.ts", statusSchemasSource()],
	]);

	if (options.openApi ?? true) {
		files.set("openapi.yaml", openApiYaml());
	}

	for (const [path, content] of files) {
		const absolutePath = join(projectDir, path);
		mkdirSync(dirname(absolutePath), { recursive: true });
		writeFileSync(absolutePath, content);
	}

	return { projectDir, files: Array.from(files.keys()) };
}

function packageJson(name: string, routaVersion: string): string {
	return `${JSON.stringify(
		{
			name,
			version: "0.0.0",
			private: true,
			type: "module",
			scripts: {
				dev: "routa dev",
				start: "routa start",
				check: "routa check",
				build: "routa build",
				lint: "biome check .",
				format: "biome check --write .",
				scaffold: "routa scaffold openapi.yaml",
				"openapi:check": "routa openapi check",
			},
			dependencies: {
				"@routa/cli": routaVersion,
				"@routa/core": routaVersion,
				tsx: "^4.22.4",
				zod: "^4.4.3",
			},
			devDependencies: {
				"@biomejs/biome": "^2.5.1",
				"@types/node": "^24.0.4",
				typescript: "^6.0.3",
			},
		},
		null,
		"\t",
	)}\n`;
}

function tsconfigJson(): string {
	return `{
\t"compilerOptions": {
\t\t"target": "ES2022",
\t\t"module": "NodeNext",
\t\t"moduleResolution": "NodeNext",
\t\t"strict": true,
\t\t"skipLibCheck": true,
\t\t"noEmitOnError": true,
\t\t"outDir": "dist",
\t\t"types": ["node"]
\t},
\t"include": ["src/**/*.ts", ".routa/**/*.ts"]
}
`;
}

function gitignore(): string {
	return `node_modules/
dist/
.env
.env.local
coverage/
`;
}

function vscodeSettings(): string {
	return `${JSON.stringify(
		{
			"files.watcherExclude": {
				"**/.routa/routes.gen.ts": true,
			},
			"search.exclude": {
				"**/.routa/routes.gen.ts": true,
			},
			"files.readonlyInclude": {
				"**/.routa/routes.gen.ts": true,
			},
			"[typescript]": {
				"editor.defaultFormatter": "biomejs.biome",
			},
			"[json]": {
				"editor.defaultFormatter": "biomejs.biome",
			},
			"[jsonc]": {
				"editor.defaultFormatter": "biomejs.biome",
			},
			"editor.codeActionsOnSave": {
				"source.organizeImports.biome": "explicit",
			},
		},
		null,
		"\t",
	)}\n`;
}

function readme(name: string): string {
	return `# ${name}

Routa API generated with \`pnpm create routa@latest\`.

## Development

\`\`\`sh
pnpm install
pnpm dev
\`\`\`

\`pnpm dev\` runs \`routa dev\`, which validates the route graph, generates Routa metadata, typechecks, and starts the internal development server.

## Scripts

\`\`\`sh
pnpm dev
pnpm start
pnpm check
pnpm build
pnpm lint
pnpm format
pnpm openapi:check
\`\`\`

## Routes

\`src/routa.ts\` is the user-owned Routa entry point. Routes live in \`src/routes\`.

\`\`\`txt
src/routa.ts
src/routes/status/route.ts
src/routes/status/schemas.ts
\`\`\`

Routa owns generated project metadata in \`.routa/\`. Commit those files so OpenAPI drift and regeneration safety work across machines.
`;
}

function biomeJson(): string {
	return `${JSON.stringify(
		{
			$schema: "./node_modules/@biomejs/biome/configuration_schema.json",
			root: false,
			vcs: {
				enabled: true,
				clientKind: "git",
				useIgnoreFile: true,
			},
			files: {
				ignoreUnknown: true,
				includes: ["**", "!node_modules", "!dist", "!coverage", "!.routa"],
			},
			formatter: {
				enabled: true,
				indentStyle: "tab",
				lineWidth: 100,
			},
			linter: {
				enabled: true,
				rules: {
					preset: "recommended",
					correctness: {
						useImportExtensions: "off",
					},
					suspicious: {
						noConsole: "off",
						noExplicitAny: "off",
					},
				},
			},
			assist: {
				enabled: true,
				actions: {
					source: {
						recommended: true,
					},
				},
			},
		},
		null,
		"\t",
	)}\n`;
}

function routaSource(): string {
	return `import { createRouta } from "@routa/core";

export default createRouta({
\tport: 3000,
});
`;
}

function openApiYaml(): string {
	return `openapi: 3.1.0
info:
  title: Routa API
  version: 0.0.0
paths:
  /status:
    get:
      operationId: getStatus
      responses:
        "200":
          description: Service status
          content:
            application/json:
              schema:
                type: object
                required:
                  - ok
                properties:
                  ok:
                    type: boolean
`;
}

function statusRouteSource(): string {
	return `import { createRoute, defineRoute } from "@routa/core";
import { GetStatusResponse } from "./schemas.js";

export default defineRoute({
\tget: createRoute({
\t\tresponses: {
\t\t\tsuccess: {
\t\t\t\tstatus: 200,
\t\t\t\tschema: GetStatusResponse,
\t\t\t},
\t\t},
\t\trun: () => ({ type: "success", data: { ok: true } }),
\t}),
});
`;
}

function statusSchemasSource(): string {
	return `import { z } from "zod";

export const GetStatusResponse = z.object({
\tok: z.boolean(),
});
`;
}
