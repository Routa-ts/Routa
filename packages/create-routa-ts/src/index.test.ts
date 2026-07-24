import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createProject } from "./create-project.js";
import { createCommandArgs, resolveRoutaVersion, runCreate } from "./index.js";

const { spawnSyncMock } = vi.hoisted(() => ({
	spawnSyncMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
	spawnSync: spawnSyncMock,
}));

describe("create-routa-ts", () => {
	afterEach(() => {
		spawnSyncMock.mockReset();
	});

	it("forwards pnpm create args to routa create", () => {
		expect(createCommandArgs(["my-api"])).toEqual(["create", "my-api"]);
	});

	it("creates a Hono-backed Routa starter app", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "create-routa-ts-"));
		const result = createProject("my-api", cwd);

		expect(result.files).toContain(".gitignore");
		expect(result.files).toContain(".nvmrc");
		expect(result.files).toContain(".vscode/settings.json");
		expect(result.files).toContain("README.md");
		expect(result.files).toContain("biome.json");
		expect(result.files).toContain("package.json");
		expect(result.files).toContain("src/routa.ts");
		expect(result.files).toContain("src/routes/status/route.test.ts");
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
		expect(packageJson).toContain('"generate": "routa generate"');
		expect(packageJson).toContain('"test": "vitest run"');
		expect(packageJson).not.toContain('"packageManager"');
		expect(packageJson).toContain('"vitest"');
		expect(packageJson).toContain('"typescript": "^7.0.2"');
		expect(packageJson).toContain("@biomejs/biome");
		// hono and zod are peer dependencies of @routa-ts/core, so the app declares them.
		expect(packageJson).toContain('"hono"');
		expect(packageJson).toContain('"zod"');
		expect(readFileSync(join(cwd, "my-api/README.md"), "utf8")).toContain(
			"<package-manager> run dev",
		);
		expect(readFileSync(join(cwd, "my-api/src/routa.ts"), "utf8")).toContain("createRouta");
		expect(readFileSync(join(cwd, "my-api/.vscode/settings.json"), "utf8")).toContain(
			"files.readonlyInclude",
		);
	});

	it("uses the target directory basename as the package name", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "create-routa-ts-nested-"));
		createProject("apps/my-api", cwd);

		expect(readFileSync(join(cwd, "apps/my-api/package.json"), "utf8")).toContain(
			'"name": "my-api"',
		);
		expect(readFileSync(join(cwd, "apps/my-api/README.md"), "utf8")).toContain("# my-api");
	});

	it("rejects target directories that escape the working directory", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "create-routa-ts-escape-"));

		expect(() => createProject("../outside-api", cwd)).toThrow(
			"Target directory must stay under the current working directory",
		);
	});

	it("rejects target basenames that are invalid package names", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "create-routa-ts-invalid-name-"));

		expect(() => createProject("My API", cwd)).toThrow(
			"Invalid package name from target directory: My API",
		);
	});

	it("rejects target basenames reserved by npm package naming rules", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "create-routa-ts-reserved-name-"));

		expect(() => createProject("node_modules", cwd)).toThrow(
			"Invalid package name from target directory: node_modules",
		);
		expect(() => createProject("favicon.ico", cwd)).toThrow(
			"Invalid package name from target directory: favicon.ico",
		);
	});

	it("prints a create summary and next steps in non-interactive mode", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "create-routa-ts-run-"));
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
			expect(output).toMatch(/(?:npm|pnpm|yarn|bun) install/);
			expect(output).toMatch(/(?:npm run|pnpm|yarn|bun run) dev/);
			expect(existsSync(join(cwd, "my-api/openapi.yaml"))).toBe(false);
			expect(existsSync(join(cwd, "my-api/.routa/manifest.json"))).toBe(false);
			expect(readFileSync(join(cwd, "my-api/package.json"), "utf8")).not.toContain("openapi:check");
			expect(readFileSync(join(cwd, "my-api/README.md"), "utf8")).not.toContain(
				"<package-manager> run openapi:check",
			);
		} finally {
			process.stdout.write = stdout;
		}
	});

	it("does not require final confirmation when all inputs are provided", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "create-routa-ts-yes-"));
		const stdinIsTTY = process.stdin.isTTY;
		const stdoutIsTTY = process.stdout.isTTY;

		Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
		Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });

		try {
			const code = await runCreate(
				["my-api", "--no-openapi", "--no-git", "--no-install", "--yes"],
				cwd,
			);

			expect(code).toBe(0);
			expect(existsSync(join(cwd, "my-api/package.json"))).toBe(true);
		} finally {
			Object.defineProperty(process.stdin, "isTTY", {
				value: stdinIsTTY,
				configurable: true,
			});
			Object.defineProperty(process.stdout, "isTTY", {
				value: stdoutIsTTY,
				configurable: true,
			});
		}
	});

	it("does not treat short flags as the target directory", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "create-routa-ts-short-flag-"));
		const code = await runCreate(["-y", "--no-openapi", "--no-git", "--no-install"], cwd);

		expect(code).toBe(0);
		expect(existsSync(join(cwd, "routa-app/package.json"))).toBe(true);
		expect(existsSync(join(cwd, "-y/package.json"))).toBe(false);
	});

	it("exits non-zero when git init fails", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "create-routa-ts-git-fail-"));
		spawnSyncMock.mockReturnValue({ status: 1, stderr: "fatal: not a git repository" });
		const stdout = process.stdout.write;
		const stderr = process.stderr.write;
		let errorOutput = "";
		process.stdout.write = (() => true) as typeof process.stdout.write;
		process.stderr.write = ((chunk: string) => {
			errorOutput += chunk;
			return true;
		}) as typeof process.stderr.write;

		try {
			const code = await runCreate(["my-api", "--no-openapi", "--git", "--no-install"], cwd);

			expect(code).toBe(1);
			expect(errorOutput).toContain("git init failed.");
			expect(existsSync(join(cwd, "my-api/package.json"))).toBe(true);
			expect(spawnSyncMock).toHaveBeenCalledWith(
				"git",
				["init"],
				expect.objectContaining({ cwd: join(cwd, "my-api") }),
			);
		} finally {
			process.stdout.write = stdout;
			process.stderr.write = stderr;
		}
	});

	it("exits non-zero when pnpm install fails", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "create-routa-ts-install-fail-"));
		spawnSyncMock.mockReturnValue({ status: 1, stderr: "ERR_PNPM_NO_MATCHING_VERSION" });
		const stdout = process.stdout.write;
		const stderr = process.stderr.write;
		let errorOutput = "";
		process.stdout.write = (() => true) as typeof process.stdout.write;
		process.stderr.write = ((chunk: string) => {
			errorOutput += chunk;
			return true;
		}) as typeof process.stderr.write;

		try {
			const code = await runCreate(["my-api", "--no-openapi", "--no-git", "--install"], cwd);

			expect(code).toBe(1);
			expect(errorOutput).toContain('Command "pnpm install" did not run successfully.');
			expect(existsSync(join(cwd, "my-api/package.json"))).toBe(true);
			expect(spawnSyncMock).toHaveBeenCalledWith(
				"pnpm",
				["install"],
				expect.objectContaining({ cwd: join(cwd, "my-api") }),
			);
		} finally {
			process.stdout.write = stdout;
			process.stderr.write = stderr;
		}
	});

	it("uses workspace packages for examples inside the Routa monorepo", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "create-routa-ts-workspace-"));
		writeFileSync(
			join(cwd, "pnpm-workspace.yaml"),
			'packages:\n  - "packages/*"\n  - "examples/*"\n',
		);
		mkdirSync(join(cwd, "examples"));

		expect(resolveRoutaVersion(join(cwd, "examples"), "basic-api")).toBe("workspace:*");
		expect(resolveRoutaVersion(cwd, "outside-api")).toBe("latest");
	});
});
