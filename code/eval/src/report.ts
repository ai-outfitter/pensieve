import type { ComparisonReport } from "./compare.ts";
import type { CaseResult, Manifest, Mode, Summary } from "./types.ts";

/** Derive `summary` from results, so writers never count by hand. EVL-001.4.3. */
export function summarize(results: CaseResult[]): Summary {
	const s: Summary = { cases: results.length, pass: 0, fail: 0, error: 0, skipped: 0 };
	for (const r of results) s[r.status]++;
	return s;
}

/** Plain words for each mode, used everywhere a mode is shown. EVL-001.3.4. */
export const MODE_LABEL: Record<Mode, string> = {
	recorded: "RECORDED (replayed model responses; no live model)",
	"real-model": "REAL MODEL (live model; synthetic or recorded connectors)",
	"live-provider": "LIVE PROVIDER (live model; real provider connectors)",
};

export function formatSummary(m: Manifest): string {
	const model = m.mode === "recorded" ? `recordings ${m.model.recordings_digest}` : `${m.model.provider}/${m.model.id}`;
	const lines = [
		`run       ${m.run.id} (attempt ${m.run.attempt}, ${m.run.status})`,
		`mode      ${MODE_LABEL[m.mode]}`,
		`subject   ${m.subject.kind} ${m.subject.id}@${m.subject.version} from ${m.subject.source.repository}@${m.subject.source.commit}${m.subject.source.dirty ? " (dirty)" : ""}`,
		`dataset   ${m.dataset.id} rev ${m.dataset.revision} (${m.dataset.cases.length} cases)`,
		`model     ${model}`,
		`results   ${m.summary.pass} pass, ${m.summary.fail} fail, ${m.summary.error} error, ${m.summary.skipped} skipped of ${m.summary.cases}`,
	];
	if (m.run.previous) lines.push(`previous  ${m.run.previous}`);
	if (m.run.regrade_of) lines.push(`regrade   of ${m.run.regrade_of}`);
	if (m.change) lines.push(`change    ${m.change.variable} vs ${m.change.baseline}: ${m.change.description}`);
	for (const g of m.gaps) lines.push(`gap       ${g.case ?? "(run)"} ${g.class}: ${g.reason}`);
	for (const r of m.results) lines.push(`  ${r.status.padEnd(7)} ${r.case}`);
	return lines.join("\n");
}

export function formatComparison(r: ComparisonReport): string {
	const lines = [
		`baseline  ${r.baseline.run} [${MODE_LABEL[r.baseline.mode]}] ${r.baseline.status}`,
		`candidate ${r.candidate.run} [${MODE_LABEL[r.candidate.mode]}] ${r.candidate.status}`,
	];
	if (!r.comparable) return [...lines, "NOT COMPARABLE", ...r.reasons.map((x) => `  ${x}`)].join("\n");
	lines.push(`declared  ${r.declared ? `${r.declared.variable}: ${r.declared.description}` : "(no change declared)"}`);
	for (const c of r.changes) {
		const flag = r.undeclared.includes(c.field) ? "UNDECLARED " : "";
		lines.push(`changed   ${flag}${c.field}: ${JSON.stringify(c.baseline)} -> ${JSON.stringify(c.candidate)}`);
	}
	if (r.mismatch) lines.push("MISMATCH  the candidate changed more than it declared");
	for (const n of r.notes) lines.push(`note      ${n}`);
	for (const c of r.cases) lines.push(`  ${c.transition.padEnd(12)} ${c.case} (${c.baseline} -> ${c.candidate})`);
	const t = r.tally;
	lines.push(`tally     ${t.fixed} fixed, ${t.regressed} regressed, ${t.unchanged_pass} still pass, ${t.unchanged_fail} still fail, ${t.not_compared} not compared (error, skipped, or missing)`);
	return lines.join("\n");
}
