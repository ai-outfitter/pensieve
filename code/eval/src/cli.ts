#!/usr/bin/env node
/**
 * pensieve-eval validate <bundle-dir...> [--publication] [--json]
 * pensieve-eval compare <baseline-dir> <candidate-dir> [--json]
 * pensieve-eval summary <bundle-dir> [--json]
 * pensieve-eval record validate <record-file...> [--blobs <dir>] [--json]
 *
 * Exit 0 on success; 1 when a bundle or record is invalid, two runs are not
 * comparable, or the candidate changed more than it declared; 2 on bad usage.
 */
import { compareManifests } from "./compare.ts";
import { readManifest, validateBundle, validateRecordFile } from "./node.ts";
import type { RecordReport } from "./record.ts";
import { formatComparison, formatSummary } from "./report.ts";
import type { ValidationReport } from "./types.ts";

const USAGE = `usage:
  pensieve-eval validate <bundle-dir...> [--publication] [--json]
  pensieve-eval compare <baseline-dir> <candidate-dir> [--json]
  pensieve-eval summary <bundle-dir> [--json]
  pensieve-eval record validate <record-file...> [--blobs <dir>] [--json]`;

function formatRecord(path: string, r: RecordReport): string {
	const head = `${r.valid ? "valid  " : "INVALID"} ${path} (${r.id ?? "unknown id"})`;
	return [
		head,
		...r.issues.map((i) => `  ${i.file}${i.field ? ` ${i.field}` : ""}: ${i.message}`),
		...r.gaps.map((g) => `  gap ${g.field}: ${g.reason}`),
	].join("\n");
}

/** `record validate`: --blobs takes a value, as `--blobs dir` or `--blobs=dir`. */
async function recordCommand(argv: string[]): Promise<number> {
	const files: string[] = [];
	let blobs: string | undefined;
	let json = false;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i]!;
		if (arg === "--json") json = true;
		else if (arg === "--blobs" && i + 1 < argv.length && blobs === undefined) blobs = argv[++i];
		else if (arg.startsWith("--blobs=") && blobs === undefined && arg.length > 8) blobs = arg.slice(8);
		else if (arg.startsWith("-")) {
			console.error(`unknown or incomplete option ${arg} for record validate\n${USAGE}`);
			return 2;
		} else files.push(arg);
	}
	if (files.length === 0) {
		console.error(USAGE);
		return 2;
	}
	let ok = true;
	const reports = [];
	for (const path of files) {
		const r = await validateRecordFile(path, { blobs });
		ok &&= r.valid;
		reports.push({ path, ...r });
		if (!json) console.log(formatRecord(path, r));
	}
	if (json) console.log(JSON.stringify(reports, null, 2));
	return ok ? 0 : 1;
}

function formatValidation(dir: string, r: ValidationReport): string {
	const head = `${r.valid ? "valid  " : "INVALID"} ${dir} (${r.mode ?? "unknown mode"}, ${r.status ?? "unknown status"})`;
	return [head, ...r.issues.map((i) => `  ${i.file}${i.field ? ` ${i.field}` : ""}: ${i.message}`)].join("\n");
}

async function requireValid(dirs: string[]): Promise<boolean> {
	let ok = true;
	for (const dir of dirs) {
		const r = await validateBundle(dir);
		if (!r.valid) {
			console.error(formatValidation(dir, r));
			ok = false;
		}
	}
	return ok;
}

export async function main(argv: string[]): Promise<number> {
	if (argv[0] === "record") {
		if (argv[1] === "validate") return recordCommand(argv.slice(2));
		console.error(USAGE);
		return 2;
	}
	const flags = argv.filter((a) => a.startsWith("-"));
	const [command, ...args] = argv.filter((a) => !a.startsWith("-"));
	const allowed = command === "validate" ? ["--json", "--publication"] : ["--json"];
	const unknown = flags.filter((f) => !allowed.includes(f));
	if (unknown.length > 0) {
		console.error(`unknown option ${unknown.join(", ")} for ${command ?? "(no command)"}\n${USAGE}`);
		return 2;
	}
	const json = flags.includes("--json");
	const publication = flags.includes("--publication");

	if (command === "validate" && args.length > 0) {
		let ok = true;
		const reports = [];
		for (const dir of args) {
			const r = await validateBundle(dir, { publication });
			ok &&= r.valid;
			reports.push({ dir, ...r });
			if (!json) console.log(formatValidation(dir, r));
		}
		if (json) console.log(JSON.stringify(reports, null, 2));
		return ok ? 0 : 1;
	}

	if (command === "compare" && args.length === 2) {
		const [baseline, candidate] = args as [string, string];
		if (!(await requireValid(args))) return 1;
		const report = compareManifests(await readManifest(baseline), await readManifest(candidate));
		console.log(json ? JSON.stringify(report, null, 2) : formatComparison(report));
		return report.comparable && !report.mismatch ? 0 : 1;
	}

	if (command === "summary" && args.length === 1) {
		const [dir] = args as [string];
		if (!(await requireValid(args))) return 1;
		const manifest = await readManifest(dir);
		console.log(json ? JSON.stringify({ run: manifest.run, mode: manifest.mode, summary: manifest.summary }, null, 2) : formatSummary(manifest));
		return 0;
	}

	console.error(USAGE);
	return 2;
}

if (import.meta.main ?? process.argv[1]?.endsWith("cli.ts")) {
	process.exitCode = await main(process.argv.slice(2));
}
