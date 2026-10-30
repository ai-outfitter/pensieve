#!/usr/bin/env node
/**
 * pensieve-eval validate <bundle-dir...> [--publication] [--json]
 * pensieve-eval compare <baseline-dir> <candidate-dir> [--json]
 * pensieve-eval summary <bundle-dir> [--json]
 *
 * Exit 0 on success; 1 when a bundle is invalid, two runs are not comparable,
 * or the candidate changed more than it declared; 2 on bad usage.
 */
import { compareManifests } from "./compare.ts";
import { readManifest, validateBundle } from "./node.ts";
import { formatComparison, formatSummary } from "./report.ts";
import type { ValidationReport } from "./types.ts";

const USAGE = `usage:
  pensieve-eval validate <bundle-dir...> [--publication] [--json]
  pensieve-eval compare <baseline-dir> <candidate-dir> [--json]
  pensieve-eval summary <bundle-dir> [--json]`;

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
	const json = argv.includes("--json");
	const publication = argv.includes("--publication");
	const [command, ...args] = argv.filter((a) => !a.startsWith("--"));

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
