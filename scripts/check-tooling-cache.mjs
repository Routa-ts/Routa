// Run without concurrent builds: this probe temporarily edits a creator template and restores it.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
const root = process.cwd(),
	source = "packages/create-routa-ts/src/create-project.ts";
const original = readFileSync(source, "utf8");
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");
const walk = (p) =>
	readdirSync(p, { withFileTypes: true }).flatMap((e) =>
		e.isDirectory() ? walk(join(p, e.name)) : [join(p, e.name)],
	);
const snapshot = () =>
	Object.fromEntries(
		["core", "cli", "create-routa-ts"]
			.flatMap((p) => walk(`packages/${p}/dist`))
			.map((p) => [p, { sha256: sha(p), mode: statSync(p).mode & 0o777 }]),
	);
const log = [];
mkdirSync(".dex/artifacts/vite-plus", { recursive: true });
function build(label) {
	const r = spawnSync("vp", ["run", "build:packages"], { cwd: root, encoding: "utf8" });
	const text = r.stdout + r.stderr;
	writeFileSync(`.dex/artifacts/vite-plus/${label}.log`, text);
	if (r.status) throw Error(text);
	return text;
}
build("cache-vp-prime");
const warm = build("cache-vp-warm");
log.push({
	scenario: "warm-cache",
	passed: /3\/3 cache hit/.test(warm),
	cacheSummary: warm.match(/vp run:.*cache hit.*/)?.[0],
});
const before = snapshot();
for (const p of ["core", "cli", "create-routa-ts"])
	rmSync(`packages/${p}/dist`, { recursive: true, force: true });
const restoredLog = build("cache-vp-restored");
const restored = snapshot();
log.push({
	scenario: "restore-deleted-outputs",
	passed: JSON.stringify(before) === JSON.stringify(restored),
	files: Object.keys(restored).length,
	cacheSummary: restoredLog.match(/vp run:.*cache hit.*/)?.[0],
});
try {
	if (!original.includes("Routa API generated with")) throw Error("Missing template probe target");
	const oldCli = sha("packages/cli/dist/index.js");
	writeFileSync(
		source,
		original.replace("Routa API generated with", "Routa API generated with CACHE_PROBE"),
	);
	const output = build("cache-vp-dependency-change");
	const creatorChanged = Object.keys(snapshot()).some(
		(p) => p.startsWith("packages/create-routa-ts/") && before[p]?.sha256 !== sha(p),
	);
	log.push({
		scenario: "creator-change-rebuilds-bundled-cli",
		passed: creatorChanged && sha("packages/cli/dist/index.js") !== oldCli,
		creatorChanged,
		cliChanged: sha("packages/cli/dist/index.js") !== oldCli,
		cacheSummary: output.match(/vp run:.*cache hit.*/)?.[0],
	});
} finally {
	writeFileSync(source, original);
	build("cache-vp-source-restored");
	log.push({
		scenario: "restore-original-source-and-outputs",
		passed: JSON.stringify(before) === JSON.stringify(snapshot()),
		files: Object.keys(snapshot()).length,
	});
	writeFileSync(
		".dex/artifacts/vite-plus/vp-only-cache-probes.json",
		JSON.stringify(log, null, 2) + "\n",
	);
}
process.stdout.write(JSON.stringify(log, null, 2) + "\n");
if (log.some((r) => !r.passed)) process.exitCode = 1;
