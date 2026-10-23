// Run without concurrent builds: this probe temporarily edits a creator template and restores it.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, rmSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
const root = process.cwd();
const source = "packages/create-routa-ts/src/create-project.ts";
const original = readFileSync(source, "utf8");
const sha = (filePath) => createHash("sha256").update(readFileSync(filePath)).digest("hex");
const walk = (directory) =>
	readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
		entry.isDirectory() ? walk(join(directory, entry.name)) : [join(directory, entry.name)],
	);
const snapshot = () =>
	Object.fromEntries(
		["core", "cli", "create-routa-ts"]
			.flatMap((packageName) => walk(`packages/${packageName}/dist`))
			.map((filePath) => [
				filePath,
				{ sha256: sha(filePath), mode: statSync(filePath).mode & 0o777 },
			]),
	);
const log = [];
mkdirSync(".artifacts/tooling", { recursive: true });
function build(label) {
	const result = spawnSync("vp", ["run", "build:packages"], { cwd: root, encoding: "utf8" });
	const text = result.stdout + result.stderr;
	writeFileSync(`.artifacts/tooling/${label}.log`, text);
	if (result.status !== 0) throw Error(text);
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
for (const packageName of ["core", "cli", "create-routa-ts"])
	rmSync(`packages/${packageName}/dist`, { recursive: true, force: true });
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
		(filePath) =>
			filePath.startsWith("packages/create-routa-ts/")
			&& before[filePath]?.sha256 !== sha(filePath),
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
		".artifacts/tooling/vp-only-cache-probes.json",
		JSON.stringify(log, null, 2) + "\n",
	);
}
process.stdout.write(JSON.stringify(log, null, 2) + "\n");
if (log.some((scenario) => !scenario.passed)) process.exitCode = 1;
