#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir, cpus, totalmem, platform, arch } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";

const args = process.argv.slice(2);
const option = (name, fallback) => {
	const i = args.indexOf(name);
	return i < 0 ? fallback : args[i + 1];
};
const root = resolve(import.meta.dirname, "..");
const baseline = resolve(option("--baseline", "/tmp/routa-vp-baseline-f07c761"));
const rounds = Number(option("--runs", "7"));
const workflowRounds = Number(option("--workflow-runs", "3"));
const output = resolve(option("--out", "docs/vite-plus-benchmarks.json"));
const logs = join(root, ".dex/artifacts/vite-plus/benchmarks");
mkdirSync(logs, { recursive: true });
if (!existsSync(join(baseline, "node_modules")))
	throw new Error("Install the baseline dependencies with vp install first.");
const baselineCommit = spawnSync("git", ["rev-parse", "HEAD"], {
	cwd: baseline,
	encoding: "utf8",
}).stdout.trim();
if (baseline === root || !baselineCommit.startsWith("f07c761"))
	throw new Error("Use an isolated checkout of baseline f07c761.");
const walk = (dir) =>
	readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
		e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
	);
const digest = (value) => createHash("sha256").update(value).digest("hex");
const packages = ["core", "cli", "create-routa-ts"];
const files = packages
	.flatMap((p) =>
		walk(join(root, "packages", p, "src"))
			.filter((p) => p.endsWith(".ts"))
			.map((p) => relative(root, p)),
	)
	.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
const seed = new Map(
	files.map((f) => [
		f,
		readFileSync(join(root, f), "utf8")
			.replace(
				"// Augmented by generated .routa/routes.gen.ts files.",
				"// biome-ignore lint/suspicious/noEmptyInterface: Augmented by generated .routa/routes.gen.ts files.",
			)
			.replace(
				/^([\t ]*)globalThis\.console\./gm,
				"$1// biome-ignore lint/suspicious/noConsole: The logger intentionally writes runtime logs.\n$1globalThis.console.",
			),
	]),
);
const fixtureRoot = mkdtempSync(join(tmpdir(), "routa-vp-matched-"));
const rootConfig = pathToFileURL(join(root, "vite.config.ts")).href;
const fixtureConfig = (typed) =>
	`import base from ${JSON.stringify(rootConfig)};\nconst rules={...base.lint.rules};\n${typed ? "" : 'delete rules["typescript/no-floating-promises"]; delete rules["typescript/no-misused-promises"];'}\nexport default {lint:{...base.lint,ignorePatterns:[],rules,options:{typeAware:${typed},typeCheck:${typed}}},fmt:{...base.fmt,ignorePatterns:[]}};\n`;
function fixture(name) {
	const dir = join(fixtureRoot, name);
	mkdirSync(dir, { recursive: true });
	for (const f of ["package.json", "pnpm-workspace.yaml", "tsconfig.base.json"])
		cpSync(join(root, f), join(dir, f));
	mkdirSync(join(dir, "node_modules", "@types"), { recursive: true });
	for (const name of readdirSync(join(root, "node_modules"))) {
		if (name === "@types" || name === ".bin" || name === "@biomejs") continue;
		symlinkSync(join(root, "node_modules", name), join(dir, "node_modules", name));
	}
	mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
	for (const name of readdirSync(join(root, "node_modules", ".bin")))
		symlinkSync(join(root, "node_modules", ".bin", name), join(dir, "node_modules", ".bin", name));
	symlinkSync(
		join(baseline, "node_modules", ".bin", "biome"),
		join(dir, "node_modules", ".bin", "biome"),
	);
	symlinkSync(join(baseline, "node_modules", "@biomejs"), join(dir, "node_modules", "@biomejs"));
	for (const name of readdirSync(join(root, "node_modules", "@types"))) {
		symlinkSync(
			join(root, "node_modules", "@types", name),
			join(dir, "node_modules", "@types", name),
		);
	}
	for (const p of packages) {
		const target = join(dir, "packages", p);
		mkdirSync(target, { recursive: true });
		symlinkSync(join(root, "packages", p, "node_modules"), join(target, "node_modules"), "dir");
		for (const f of ["package.json", "tsconfig.json", "tsconfig.test.json"])
			cpSync(join(root, "packages", p, f), join(target, f));
	}
	// Both matched tiers use explicit programs that own every test file.
	for (const p of packages) {
		const configPath = join(dir, "packages", p, "tsconfig.json");
		const config = JSON.parse(readFileSync(configPath, "utf8"));
		config.exclude = [];
		config.compilerOptions.types = ["node", "vite-plus/test/globals"];
		writeFileSync(configPath, JSON.stringify(config));
	}
	const biome = JSON.parse(readFileSync(join(baseline, "biome.json"), "utf8"));
	biome.vcs.enabled = false;
	writeFileSync(join(dir, "biome.json"), JSON.stringify(biome));
	writeFileSync(join(dir, "vite.config.ts"), fixtureConfig(false));
	restore(dir, false);
	return dir;
}
function restore(dir, messy) {
	for (const [file, source] of seed) {
		const p = join(dir, file);
		mkdirSync(dirname(p), { recursive: true });
		writeFileSync(p, messy ? source.replaceAll("\t", "   ") : source);
	}
}
const lintFixture = fixture("lint"),
	biomeFormat = fixture("biome-format"),
	vpFormat = fixture("vp-format");
const previous =
	args.includes("--resume") && existsSync(output) ? JSON.parse(readFileSync(output, "utf8")) : null;
const selected = option("--only", "").split(",").filter(Boolean);
const remeasure = option("--remeasure", "").split(",").filter(Boolean);
if (![rounds, workflowRounds].every((n) => Number.isInteger(n) && n > 0))
	throw new Error("Run counts must be positive integers.");
if (previous) {
	const sha = digest([...seed].map(([p, t]) => p + "\0" + t).join("\0"));
	if (previous.methodology.matchedCorpus.sha256 !== sha)
		throw new Error("The source corpus changed. Use a fresh output file instead of --resume.");
	if (
		previous.methodology.smallRuns !== rounds
		|| previous.methodology.workflowRuns !== workflowRounds
	)
		throw new Error("Run counts must match the resumed dataset.");
	previous.comparisons = previous.comparisons.filter((c) => !remeasure.includes(c.id));
	previous.records = previous.records.filter(
		(r) => !remeasure.some((id) => r.label.startsWith(id + "-")),
	);
}
const records = previous?.records ?? [];
let serial = readdirSync(logs).reduce(
	(n, name) => Math.max(n, Number(name.split("-")[0]) + 1 || 0),
	0,
);
function run(command, cwd, label, warmup = false) {
	if (command[0] !== "vp") throw new Error("Benchmark commands must use vp.");
	const timed = platform() === "darwin";
	const start = performance.now();
	const r = spawnSync(
		timed ? "/usr/bin/time" : command[0],
		timed ? ["-l", ...command] : command.slice(1),
		{ cwd, encoding: "utf8", maxBuffer: 20 * 1024 * 1024, env: process.env },
	);
	const seconds = (performance.now() - start) / 1000;
	const text = (r.stdout ?? "") + (r.stderr ?? "");
	const name = `${String(serial++).padStart(3, "0")}-${label}.log`;
	writeFileSync(join(logs, name), text);
	if (r.status !== 0)
		throw new Error(`${label} failed (${r.status}). See ${join(logs, name)}\n${text.slice(-2500)}`);
	const memory = Number(text.match(/(\d+)\s+maximum resident set size/)?.[1]);
	const cpu = text.match(/[\d.]+\s+real\s+([\d.]+)\s+user\s+([\d.]+)\s+sys/);
	const engine =
		text.match(/Finished in ([\d.]+)(ms|µs|s) on/)
		?? text.match(/(?:Checked|Formatted) \d+ files in ([\d.]+)(ms|µs|s)/)
		?? text.match(/in \d+ files \(([\d.]+)(ms|µs|s),/);
	const engineMs = engine
		? Number(engine[1]) * (engine[2] === "s" ? 1000 : engine[2] === "µs" ? 0.001 : 1)
		: null;
	const result = {
		seconds,
		peakRssMiB: memory ? memory / 1024 / 1024 : null,
		cpuSeconds: cpu ? Number(cpu[1]) + Number(cpu[2]) : null,
		engineMs,
		exitCode: r.status,
		log: name,
		legacyTestCacheHits: (text.match(/:test: cache hit/g) ?? []).length,
		executedTestCounts: [...text.matchAll(/Tests\s+(\d+) passed/g)].map((m) => Number(m[1])),
		cacheHits: Number(text.match(/vp run: (\d+)\/\d+ cache hit/)?.[1] ?? 0),
	};
	if (!warmup)
		records.push({
			...result,
			label,
			command,
			cwd:
				cwd === root
					? "migrated checkout"
					: cwd === baseline
						? "baseline checkout"
						: "matched fixture",
		});
	return result;
}
const summary = (values) => {
	const x = values.filter((v) => v !== null).sort((a, b) => a - b);
	return x.length
		? {
				median: x.length % 2 ? x[(x.length - 1) / 2] : (x[x.length / 2 - 1] + x[x.length / 2]) / 2,
				min: x[0],
				max: x.at(-1),
			}
		: null;
};
const comparisons = previous?.comparisons ?? [];
function save() {
	writeFileSync(
		output,
		JSON.stringify(
			{
				schemaVersion: 1,
				date: new Date().toISOString(),
				baselineCommit: spawnSync("git", ["rev-parse", "HEAD"], {
					cwd: baseline,
					encoding: "utf8",
				}).stdout.trim(),
				environment: {
					platform: platform(),
					arch: arch(),
					node: process.version,
					cpu: cpus()[0].model,
					logicalCpus: cpus().length,
					memoryGiB: totalmem() / 1024 ** 3,
					vitePlus: "1.3.0",
				},
				methodology: {
					smallRuns: rounds,
					workflowRuns: workflowRounds,
					warmups: 1,
					order: "Alternating AB/BA pairs, serial execution",
					timing:
						"Wall time includes vp launch and all child processes; /usr/bin/time -l measures peak RSS and CPU on macOS",
					cold: "Task caches removed, dependencies installed and OS file cache warm; not a cold machine",
					matchedCorpus: {
						fileCount: files.length,
						bytes: [...seed.values()].reduce((s, t) => s + Buffer.byteLength(t), 0),
						sha256: digest([...seed].map(([p, t]) => p + "\0" + t).join("\0")),
						files,
					},
					baselineHarness:
						"Only command orchestration is translated to vp; original tools, source and test exclusions remain. Legacy test user-agent is fixed to its previous pnpm context. Node symlinks in baseline .bin directories ensure Node 24.18.0 for Turbo child workloads. Turbo cache is isolated.",
				},
				comparisons,
				records,
			},
			null,
			"\t",
		) + "\n",
	);
	const formatted = spawnSync("vp", ["fmt", output], {
		cwd: root,
		encoding: "utf8",
	});
	if (formatted.status !== 0)
		throw new Error("Cannot format benchmark output: " + formatted.stderr);
}
function compare(id, title, a, b, n, setupA, setupB, note) {
	if (selected.length && !selected.includes(id)) return;
	if (comparisons.some((c) => c.id === id)) {
		process.stdout.write(`Resume: ${id} already measured\n`);
		return;
	}
	process.stdout.write(`Start ${id}: ${n} measured pairs plus warmup\n`);
	setupA?.();
	run(a.command, a.cwd, `${id}-before-warmup`, true);
	setupB?.();
	run(b.command, b.cwd, `${id}-after-warmup`, true);
	const results = { before: [], after: [] };
	for (let i = 0; i < n; i++)
		for (const side of i % 2 ? ["after", "before"] : ["before", "after"]) {
			const spec = side === "before" ? a : b;
			(side === "before" ? setupA : setupB)?.();
			results[side].push(run(spec.command, spec.cwd, `${id}-${side}-${i + 1}`));
		}
	const sums = Object.fromEntries(
		Object.entries(results).map(([side, r]) => [
			side,
			{
				wallSeconds: summary(r.map((x) => x.seconds)),
				peakRssMiB: summary(r.map((x) => x.peakRssMiB)),
				cpuSeconds: summary(r.map((x) => x.cpuSeconds)),
				engineMs: summary(r.map((x) => x.engineMs)),
			},
		]),
	);
	const changePercent = (sums.after.wallSeconds.median / sums.before.wallSeconds.median - 1) * 100;
	comparisons.push({
		id,
		title,
		runs: n,
		beforeCommand: a.command,
		afterCommand: b.command,
		...sums,
		changePercent,
		note,
	});
	save();
	process.stdout.write(
		`Done ${id}: ${sums.before.wallSeconds.median.toFixed(3)}s -> ${sums.after.wallSeconds.median.toFixed(3)}s (${changePercent.toFixed(1)}%)\n`,
	);
}
const spec = (cwd, ...command) => ({ cwd, command });
// Canonical check inputs are normalized once by each engine from the same source seed.
run(
	["vp", "exec", "biome", "format", "--write", ...files],
	biomeFormat,
	"format-biome-normalize",
	true,
);
run(["vp", "fmt", ...files], vpFormat, "format-vp-normalize", true);
compare(
	"format-check",
	"Format check: same file set",
	spec(biomeFormat, "vp", "exec", "biome", "format", ...files),
	spec(vpFormat, "vp", "fmt", "--check", ...files),
	rounds,
	null,
	null,
	"Same source seed; each formatter checks its own canonical output. File count is identical.",
);
compare(
	"format-write",
	"Format write: identical indented input",
	spec(biomeFormat, "vp", "exec", "biome", "format", "--write", ...files),
	spec(vpFormat, "vp", "fmt", ...files),
	rounds,
	() => restore(biomeFormat, true),
	() => restore(vpFormat, true),
	"Every round restores byte-identical input with tabs replaced by three spaces; restoration is outside the timer.",
);
compare(
	"syntax-lint",
	"Syntax lint: identical bytes",
	spec(lintFixture, "vp", "exec", "biome", "lint", ...files),
	spec(lintFixture, "vp", "lint", ...files),
	rounds,
	null,
	null,
	"Same files and bytes. Oxlint type-aware rules and compiler diagnostics are disabled in this tier. Rule sets differ.",
);
writeFileSync(join(lintFixture, "vite.config.ts"), fixtureConfig(true));
const checks = packages.map((p) => `tsc -p packages/${p}/tsconfig.test.json --noEmit`).join(" && ");
compare(
	"typed-check",
	"Lint plus type diagnostics on identical source",
	spec(lintFixture, "vp", "exec", "-c", `biome lint ${files.join(" ")} && ${checks}`),
	spec(lintFixture, "vp", "lint", ...files),
	rounds,
	null,
	null,
	"Baseline Biome plus explicit TypeScript programs includes all nine tests for this matched tier. Oxlint combines lint and experimental diagnostics; explicit tsc remains in the real migrated gate.",
);
compare(
	"package-build-uncached",
	"Three package builds without task cache",
	spec(baseline, "vp", "run", "--filter", "./packages/*", "build"),
	spec(root, "vp", "run", "--no-cache", "build:packages"),
	rounds,
	null,
	null,
	"Original tsc/esbuild builder versus vp pack. Same three packages and public entry points. Output directories are cleaned by both builders.",
);
compare(
	"package-build-warm",
	"Three package builds with warm task caches",
	spec(
		baseline,
		"vp",
		"exec",
		"turbo",
		"run",
		"build",
		"--filter=./packages/*",
		"--cache-dir=/tmp/routa-vp-baseline-turbo-cache",
	),
	spec(root, "vp", "run", "build:packages"),
	rounds,
	null,
	null,
	"Turbo and Vite Task caches are primed before timing. Both replay build results; tests are not part of this row.",
);
compare(
	"tests",
	"Execute all 204 framework tests",
	spec(baseline, "vp", "run", "--filter", "./packages/*", "test"),
	spec(root, "vp", "run", "test"),
	workflowRounds,
	null,
	null,
	"Both execute 204 tests in nine files, with package outputs already built. Baseline uses Vitest 5.0.3, migrated uses bundled 5.0.5; build prerequisite is cached on migrated side.",
);
compare(
	"package-typecheck",
	"Explicit source/test TypeScript checks",
	spec(baseline, "vp", "run", "--filter", "./packages/*", "typecheck"),
	spec(root, "vp", "run", "--filter", "./packages/*", "typecheck"),
	rounds,
	null,
	null,
	"Real configurations: baseline includes one of nine test files; migrated includes all nine. Both still check source. This is a coverage/cost comparison, not equal work.",
);
compare(
	"verify-cold-tasks",
	"Full verification with cold task caches",
	spec(baseline, "vp", "run", "verify"),
	spec(root, "vp", "run", "verify"),
	workflowRounds,
	() => rmSync("/tmp/routa-vp-baseline-turbo-cache", { recursive: true, force: true }),
	() => rmSync(join(root, "node_modules/.vite/task-cache"), { recursive: true, force: true }),
	"Task caches cleared before every sample; dependency installations and OS caches remain warm. Both must execute all framework tests. Includes packed installs and network-sensitive registry resolution.",
);
compare(
	"verify-warm-tasks",
	"Full verification with warm task caches",
	spec(baseline, "vp", "run", "verify"),
	spec(root, "vp", "run", "verify"),
	workflowRounds,
	null,
	null,
	"Normal warm-cache policies differ: legacy Turbo may replay tests/types; migrated executes tests/types and caches only package builds. Includes packed installs and network-sensitive registry resolution.",
);

compare(
	"workspace-build-cold",
	"All seven workspace builds, cold task caches",
	spec(baseline, "vp", "run", "build"),
	spec(root, "vp", "run", "build"),
	workflowRounds,
	() => rmSync("/tmp/routa-vp-baseline-turbo-cache", { recursive: true, force: true }),
	() => rmSync(join(root, "node_modules/.vite/task-cache"), { recursive: true, force: true }),
	"Both build three packages, two examples, docs and design. Task caches are cleared; installed dependencies and OS caches stay warm.",
);
compare(
	"workspace-build-warm",
	"All seven workspace builds, warm task caches",
	spec(baseline, "vp", "run", "build"),
	spec(root, "vp", "run", "build"),
	workflowRounds,
	null,
	null,
	"Policy differs: Turbo caches all seven builds; this VP candidate caches only the three library builds. Astro and example build scripts execute. This is configurable, not a Vite Task limitation.",
);

process.stdout.write(`Wrote ${output}\n`);
