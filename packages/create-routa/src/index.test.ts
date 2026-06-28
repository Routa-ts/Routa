import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createProject } from "./create-project.js";
import { createCommandArgs, resolveRoutaVersion, runCreate } from "./index.js";

describe("create-routa", () => {
	it("forwards pnpm create args to routa create", () => {
		expect(createCommandArgs(["my-api"])).toEqual(["create", "my-api"]);
	});

	it("creates a Hono-backed Routa starter app", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "create-routa-"));
		const result = createProject("my-api", cwd);

		expect(result.files).toContain(".gitignore");
		expect(result.files).toContain(".vscode/settings.json");
		expect(result.files).toContain("README.md");
		expect(result.files).toContain("biome.json");
		expect(result.files).toContain("package.json");
		expect(result.files).toContain("src/routa.ts");
		expect(result.files).toContain("tsconfig.json");
		expect(result.files).toContain(".routa/manifest.json");
		expect(result.files).toContain(".routa/openapi-baseline.json");
		expect(result.files).toContain(".routa/routes.gen.ts");
		expect(existsSync(join(cwd, "my-api/src/index.ts"))).toBe(false);
		expect(existsSync(join(cwd, "my-api/src/routes/status/route.ts"))).toBe(true);
		expect(existsSync(join(cwd, "my-api/openapi.yaml"))).toBe(true);
		expect(existsSync(join(cwd, "my-api/.routa/manifest.json"))).toBe(true);
		expect(readFileSync(join(cwd, "my-api/.routa/manifest.json"), "utf8")).toContain(
			"src/routes/status/route.ts",
		);
		expect(readFileSync(join(cwd, "my-api/.routa/openapi-baseline.json"), "utf8")).toContain(
			'"operationId": "getStatus"',
		);
		expect(readFileSync(join(cwd, "my-api/.routa/routes.gen.ts"), "utf8")).toContain('"/status"');
		const packageJson = readFileSync(join(cwd, "my-api/package.json"), "utf8");
		expect(packageJson).toContain('"dev": "routa dev"');
		expect(packageJson).toContain('"start": "routa start"');
		expect(packageJson).toContain("@biomejs/biome");
		expect(packageJson).not.toContain('"hono"');
		expect(readFileSync(join(cwd, "my-api/README.md"), "utf8")).toContain("pnpm dev");
		expect(readFileSync(join(cwd, "my-api/src/routa.ts"), "utf8")).toContain("createRouta");
		expect(readFileSync(join(cwd, "my-api/.vscode/settings.json"), "utf8")).toContain(
			"files.readonlyInclude",
		);
	});

	it("prints a create summary and next steps in non-interactive mode", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "create-routa-run-"));
		const stdout = process.stdout.write;
		let output = "";
		process.stdout.write = ((chunk: string) => {
			output += chunk;
			return true;
		}) as typeof process.stdout.write;

		try {
			const code = await runCreate(["my-api", "--no-openapi", "--no-git", "--no-install"], cwd);

			expect(code).toBe(0);
			expect(output).toContain("Let's configure your Routa API");
			expect(output).toContain("About to create:");
			expect(output).toContain("OpenAPI starter: no");
			expect(output).toContain("pnpm install");
			expect(output).toContain("pnpm dev");
			expect(existsSync(join(cwd, "my-api/openapi.yaml"))).toBe(false);
			expect(existsSync(join(cwd, "my-api/.routa/manifest.json"))).toBe(false);
		} finally {
			process.stdout.write = stdout;
		}
	});

	it("uses workspace packages for examples inside the Routa monorepo", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "create-routa-workspace-"));
		writeFileSync(
			join(cwd, "pnpm-workspace.yaml"),
			'packages:\n  - "packages/*"\n  - "examples/*"\n',
		);
		mkdirSync(join(cwd, "examples"));

		expect(resolveRoutaVersion(join(cwd, "examples"), "basic-api")).toBe("workspace:*");
		expect(resolveRoutaVersion(cwd, "outside-api")).toBe("latest");
	});
});
