import { resolve } from "node:path";
import type { Node, SourceFile } from "typescript/unstable/ast";
import { API } from "typescript/unstable/sync";

export * from "typescript/unstable/ast";
export {
	isStringLiteralLikeNode as isStringLiteralLike,
	isTypeAssertion as isTypeAssertionExpression,
} from "typescript/unstable/ast";

type CachedSourceFile = {
	source: string;
	sourceFile: SourceFile;
};

export type SourceFileParser = {
	createSourceFile(fileName: string, source: string): SourceFile;
	close(): void;
};

class NativeSourceFileParser implements SourceFileParser {
	private readonly api: API;
	private readonly files = new Map<string, string>();
	private readonly cache = new Map<string, CachedSourceFile>();
	private snapshot: ReturnType<API["updateSnapshot"]> | undefined;
	private closed = false;

	constructor(private readonly cwd: string) {
		this.api = new API({
			cwd,
			fs: {
				fileExists: (candidate) => (this.files.has(resolve(candidate)) ? true : undefined),
				readFile: (candidate) => this.files.get(resolve(candidate)),
			},
		});
	}

	createSourceFile(fileName: string, source: string): SourceFile {
		if (this.closed) {
			throw new Error("TypeScript source-file parser is closed.");
		}

		const file = resolve(this.cwd, fileName);
		const cached = this.cache.get(file);

		if (cached?.source === source) {
			return cached.sourceFile;
		}

		const alreadyOpen = this.files.has(file);
		this.files.set(file, source);
		const nextSnapshot = this.api.updateSnapshot(
			alreadyOpen ? { fileChanges: { changed: [file] } } : { openFiles: [file] },
		);

		try {
			const sourceFile = nextSnapshot.getDefaultProjectForFile(file)?.program.getSourceFile(file);

			if (!sourceFile) {
				throw new Error(`TypeScript could not parse ${fileName}.`);
			}

			this.snapshot?.dispose();
			this.snapshot = nextSnapshot;
			this.cache.set(file, { source, sourceFile });
			return sourceFile;
		} catch (error) {
			nextSnapshot.dispose();
			throw error;
		}
	}

	close(): void {
		if (this.closed) {
			return;
		}

		this.closed = true;
		this.snapshot?.dispose();
		this.snapshot = undefined;
		this.api.close();
		this.cache.clear();
		this.files.clear();
	}
}

/** Creates a reusable native TypeScript parser for one project-scoped parse batch. */
export function createSourceFileParser(cwd: string): SourceFileParser {
	return new NativeSourceFileParser(resolve(cwd));
}

/**
 * Reuses one native TypeScript API and its project cache for a synchronous parse batch.
 */
export function withSourceFileParsing<T>(
	cwd: string,
	callback: (parser: SourceFileParser) => T,
): T {
	const parser = createSourceFileParser(cwd);

	try {
		return callback(parser);
	} finally {
		parser.close();
	}
}

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
	return withSourceFileParsing(process.cwd(), (parser) =>
		parser.createSourceFile(fileName, source),
	);
}

/** Compatibility wrapper for the legacy namespace-level traversal helper. */
export function forEachChild<T>(node: Node, visitor: (child: Node) => T): T | undefined {
	return node.forEachChild(visitor);
}
