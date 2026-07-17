import { resolve } from "node:path";
import type { Node, SourceFile } from "typescript/unstable/ast";
import { API } from "typescript/unstable/sync";

export * from "typescript/unstable/ast";
export {
	isStringLiteralLikeNode as isStringLiteralLike,
	isTypeAssertion as isTypeAssertionExpression,
} from "typescript/unstable/ast";

/**
 * Parses TypeScript source through the TypeScript 7 native API.
 *
 * The native compiler no longer exposes the legacy JavaScript `createSourceFile`
 * API. A virtual file keeps Routa's existing source-string parsing behavior while
 * letting the native compiler own parsing and AST construction.
 */
export function createSourceFile(
	fileName: string,
	source: string,
	..._legacyOptions: readonly unknown[]
): SourceFile {
	const file = resolve(fileName);
	const api = new API({
		cwd: process.cwd(),
		fs: {
			fileExists: (candidate) => (candidate === file ? true : undefined),
			readFile: (candidate) => (candidate === file ? source : undefined),
		},
	});
	const snapshot = api.updateSnapshot({ openFiles: [file] });

	try {
		const sourceFile = snapshot.getDefaultProjectForFile(file)?.program.getSourceFile(file);

		if (!sourceFile) {
			throw new Error(`TypeScript could not parse ${fileName}.`);
		}

		return sourceFile;
	} finally {
		snapshot.dispose();
		api.close();
	}
}

/** Compatibility wrapper for the legacy namespace-level traversal helper. */
export function forEachChild<T>(node: Node, visitor: (child: Node) => T): T | undefined {
	return node.forEachChild(visitor);
}
