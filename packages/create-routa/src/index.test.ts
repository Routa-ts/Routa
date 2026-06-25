import { existsSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCommandArgs } from "./index.js";
import { createProject } from "./create-project.js";

describe("create-routa", () => {
	it("forwards pnpm create args to routa create", () => {
		expect(createCommandArgs(["my-api"])).toEqual(["create", "my-api"]);
	});

	it("creates a Hono-backed Routa starter app", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "create-routa-"));
		const result = createProject("my-api", cwd);

		expect(result.files).toContain("package.json");
		expect(existsSync(join(cwd, "my-api/src/index.ts"))).toBe(true);
		expect(existsSync(join(cwd, "my-api/routes/status/route.ts"))).toBe(true);
		expect(existsSync(join(cwd, "my-api/openapi.yaml"))).toBe(true);
		expect(readFileSync(join(cwd, "my-api/src/index.ts"), "utf8")).toContain("@routa/core/hono");
	});
});
