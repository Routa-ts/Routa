import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export type CreateProjectResult = {
	projectDir: string;
	files: string[];
};

export function createProject(targetDir: string, cwd = process.cwd()): CreateProjectResult {
	const projectDir = resolve(cwd, targetDir);

	if (existsSync(projectDir)) {
		throw new Error(`Target directory already exists: ${targetDir}`);
	}

	const files = new Map<string, string>([
		["package.json", packageJson(targetDir)],
		["tsconfig.json", tsconfigJson()],
		["openapi.yaml", openApiYaml()],
		["src/index.ts", serverSource()],
		["routes/status/route.ts", statusRouteSource()],
		["routes/status/schemas.ts", statusSchemasSource()],
	]);

	for (const [path, content] of files) {
		const absolutePath = join(projectDir, path);
		mkdirSync(dirname(absolutePath), { recursive: true });
		writeFileSync(absolutePath, content);
	}

	return { projectDir, files: Array.from(files.keys()) };
}

function packageJson(name: string): string {
	return `${JSON.stringify(
		{
			name,
			version: "0.0.0",
			private: true,
			type: "module",
			scripts: {
				dev: "tsx src/index.ts",
				check: "routa check",
				build: "routa build",
				scaffold: "routa scaffold openapi.yaml",
			},
			dependencies: {
				"@routa/cli": "latest",
				"@routa/core": "latest",
				hono: "^4.0.0",
				zod: "^3.0.0",
			},
			devDependencies: {
				tsx: "^4.0.0",
				typescript: "^5.0.0",
			},
		},
		null,
		"\t",
	)}\n`;
}

function tsconfigJson(): string {
	return `${JSON.stringify(
		{
			compilerOptions: {
				target: "ES2022",
				module: "NodeNext",
				moduleResolution: "NodeNext",
				strict: true,
				skipLibCheck: true,
			},
			include: ["src/**/*.ts", "routes/**/*.ts", ".routa/**/*.ts"],
		},
		null,
		"\t",
	)}\n`;
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

function serverSource(): string {
	return `import { createHonoApp } from "@routa/core/hono";
import statusRoute from "../routes/status/route.js";

const app = createHonoApp([
\t{
\t\tmethod: "get",
\t\tpath: "/status",
\t\tcontract: statusRoute.get,
\t},
]);

export default app;
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
\t\trun: async () => ({ type: "success", data: { ok: true } }),
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
