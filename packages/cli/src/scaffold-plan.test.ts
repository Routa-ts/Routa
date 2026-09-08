import { createHash } from "node:crypto";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createScaffoldPlan, evaluateScaffold, type ScaffoldPlan } from "./scaffold-plan.js";

function planWith(paths: string[]) {
	return createScaffoldPlan(
		JSON.stringify({
			openapi: "3.1.0",
			info: { title: "Test", version: "1" },
			paths: Object.fromEntries(
				paths.map((path) => [
					path,
					{
						get: {
							operationId: `get${path.slice(1)}`,
							responses: {
								"200": {
									description: "OK",
									content: {
										"application/json": {
											schema: {
												type: "object",
												properties: { ok: { type: "boolean" } },
												required: ["ok"],
											},
										},
									},
								},
							},
						},
					},
				]),
			),
		}),
		".json",
		"openapi.json",
	);
}

function snapshot(plan: ScaffoldPlan) {
	return {
		manifest: plan.manifest,
		files: new Map([...plan.files, [".routa/manifest.json", plan.manifestContent]]),
	};
}

describe("scaffold plan", () => {
	it.each([undefined, ""])("blocks overwriting a retained file with hash %s", (hash) => {
		const plan = planWith(["/status"]);
		const state = snapshot(plan);
		const path = join("src", "routes", "status", "route.ts");
		state.manifest.generated = state.manifest.generated.map((entry) =>
			entry.path === path ? { ...entry, sha256: hash } : entry,
		);
		state.files.set(path, "export const localEdit = true;");
		const result = evaluateScaffold(plan, state);
		expect(result.changes.find((change) => change.path === path)?.status).toBe("conflict");
		expect(result.blocked).toContain("ROUTA_SCAFFOLD_MODIFIED_GENERATED_FILE");
		expect(result.blocked).toContain("manifest hash is missing");
	});

	it("blocks removing a stale file whose manifest hash is missing", () => {
		const previous = planWith(["/obsolete"]);
		const state = snapshot(previous);
		const path = join("src", "routes", "obsolete", "route.ts");
		state.manifest.generated = state.manifest.generated.map((entry) =>
			entry.path === path ? { ...entry, sha256: undefined } : entry,
		);
		state.files.set(path, "export const localEdit = true;");
		const result = evaluateScaffold(planWith(["/status"]), state);
		expect(result.changes.find((change) => change.path === path)?.status).toBe("conflict");
		expect(result.blocked).toContain("ROUTA_SCAFFOLD_MODIFIED_GENERATED_FILE");
		expect(result.blocked).toContain("manifest hash is missing");
	});

	it("blocks an unmanaged route without a manifest", () => {
		const plan = planWith(["/status"]);
		const path = join("src", "routes", "status", "route.ts");
		const result = evaluateScaffold(plan, {
			files: new Map([[path, "export const localEdit = true;"]]),
		});
		expect(result.changes.find((change) => change.path === path)?.status).toBe("conflict");
		expect(result.blocked).toContain("ROUTA_SCAFFOLD_UNMANAGED_FILE");
	});

	it("regenerates framework metadata without a recorded hash", () => {
		const plan = planWith(["/status"]);
		const state = snapshot(plan);
		const path = ".routa/routes.gen.ts";
		state.manifest.generated = state.manifest.generated.map((entry) =>
			entry.path === path ? { ...entry, sha256: undefined } : entry,
		);
		state.files.set(path, "// stale framework metadata");
		state.files.set(".routa/manifest.json", "{}");
		const result = evaluateScaffold(plan, state);
		expect(result.blocked).toBeUndefined();
		expect(result.changes.find((change) => change.path === path)?.status).toBe("update");
		expect(result.changes.find((change) => change.path === ".routa/manifest.json")?.status).toBe(
			"update",
		);
	});

	it("renders deterministic source, metadata and matching manifest hashes from OpenAPI", () => {
		const first = planWith(["/status"]);
		const second = planWith(["/status"]);
		expect([...first.files]).toEqual([...second.files]);
		expect(first.manifestContent).toBe(second.manifestContent);
		expect(first.fileList).toEqual([
			join("src", "routes", "status", "route.ts"),
			join("src", "routes", "status", "schemas.ts"),
			".routa/openapi-baseline.json",
			".routa/manifest.json",
			".routa/routes.gen.ts",
		]);
		expect(first.files.get(join("src", "routes", "status", "route.ts"))).toContain(
			'createRouteRoot("/status")',
		);
		expect(first.files.get(".routa/routes.gen.ts")).toContain('"/status"');
		for (const entry of first.manifest.generated) {
			const content = first.files.get(entry.path);
			expect(content).toBeDefined();
			expect(entry.sha256).toBe(
				createHash("sha256")
					.update(content ?? "")
					.digest("hex"),
			);
		}
		expect(
			evaluateScaffold(first, snapshot(first)).changes.every((c) => c.status === "unchanged"),
		).toBe(true);
	});

	it("classifies a modified stale file as a conflict", () => {
		const previous = planWith(["/status", "/obsolete"]);
		const next = planWith(["/status"]);
		const state = snapshot(previous);
		const path = join("src", "routes", "obsolete", "route.ts");
		state.files.set(path, "export const localEdit = true;");
		const evaluation = evaluateScaffold(next, state);
		expect(evaluation.changes.find((c) => c.path === path)?.status).toBe("conflict");
		expect(evaluation.blocked).toContain("ROUTA_SCAFFOLD_MODIFIED_GENERATED_FILE");
	});

	it("marks clean stale files for removal and missing outputs for addition", () => {
		const previous = planWith(["/obsolete"]);
		const next = planWith(["/status"]);
		const result = evaluateScaffold(next, snapshot(previous));
		expect(result.blocked).toBeUndefined();
		expect(
			result.changes.find((c) => c.path === join("src", "routes", "obsolete", "route.ts"))?.status,
		).toBe("remove");
		expect(
			result.changes.find((c) => c.path === join("src", "routes", "status", "route.ts"))?.status,
		).toBe("add");
	});
});
