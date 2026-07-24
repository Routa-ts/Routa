import { beforeEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
	apis: [] as Array<{
		close: ReturnType<typeof vi.fn>;
		updateSnapshot: ReturnType<typeof vi.fn>;
	}>,
	snapshots: [] as Array<{ dispose: ReturnType<typeof vi.fn> }>,
}));

vi.mock("typescript/unstable/sync", () => ({
	API: class {
		readonly close = vi.fn();
		readonly sourceFiles = new Map<string, object>();
		readonly updateSnapshot = vi.fn(
			(params: { openFiles?: string[]; fileChanges?: { changed?: string[] } }) => {
				const file = params.openFiles?.[0] ?? params.fileChanges?.changed?.[0];
				const sourceFile = this.sourceFiles.get(file ?? "") ?? {};
				this.sourceFiles.set(file ?? "", sourceFile);
				const snapshot = {
					dispose: vi.fn(),
					getDefaultProjectForFile: () => ({
						program: { getSourceFile: () => sourceFile },
					}),
				};
				native.snapshots.push(snapshot);
				return snapshot;
			},
		);

		constructor() {
			native.apis.push(this);
		}
	},
}));

import { createSourceFileParser } from "./typescript.js";

describe("TypeScript source-file parsing", () => {
	beforeEach(() => {
		native.apis.length = 0;
		native.snapshots.length = 0;
	});

	it("reuses one API and cached source files across a parse batch", () => {
		let first: object | undefined;
		let repeated: object | undefined;

		const parser = createSourceFileParser("/project");
		try {
			first = parser.createSourceFile("first.ts", "export const first = true;");
			parser.createSourceFile("second.ts", "export const second = true;");
			repeated = parser.createSourceFile("first.ts", "export const first = true;");
		} finally {
			parser.close();
			parser.close();
		}

		expect(native.apis).toHaveLength(1);
		expect(native.apis[0]?.updateSnapshot).toHaveBeenCalledTimes(2);
		expect(first).toBe(repeated);
		expect(native.snapshots[0]?.dispose).toHaveBeenCalledOnce();
		expect(native.snapshots[1]?.dispose).toHaveBeenCalledOnce();
		expect(native.apis[0]?.close).toHaveBeenCalledOnce();
	});

	it("updates an open virtual file without replacing its API", () => {
		const parser = createSourceFileParser("/project");
		try {
			parser.createSourceFile("snippet.ts", "export const value = 1;");
			parser.createSourceFile("snippet.ts", "export const value = 2;");
		} finally {
			parser.close();
		}

		expect(native.apis).toHaveLength(1);
		expect(native.apis[0]?.updateSnapshot).toHaveBeenNthCalledWith(2, {
			fileChanges: { changed: ["/project/snippet.ts"] },
		});
		expect(native.snapshots[0]?.dispose).toHaveBeenCalledOnce();
		expect(native.snapshots[1]?.dispose).toHaveBeenCalledOnce();
		expect(native.apis[0]?.close).toHaveBeenCalledOnce();
	});
});
