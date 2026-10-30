import { canonicalize } from "./canonical.ts";
import type { CaseStatus, ChangeVariable, Manifest, Mode } from "./types.ts";

/** Provenance fields a comparison inspects. EVL-001.7.2. */
export const PROVENANCE_FIELDS = [
	"mode",
	"subject.version",
	"subject.definition_digest",
	"subject.source.commit",
	"subject.source.dirty",
	"prompts",
	"model.provider",
	"model.id",
	"model.configuration",
	"model.recordings_digest",
] as const;
export type ProvenanceField = (typeof PROVENANCE_FIELDS)[number];

/**
 * Which provenance differences each declared variable accounts for.
 * EVL-001.7.3. A prompt edit lands as a new commit, and workflow prompts live
 * inside the definition, so `prompts` covers both; a commit change covers
 * everything derived from source. Mode, dirtiness, and recordings are never
 * covered.
 */
export const CHANGE_COVERS: Record<ChangeVariable, readonly ProvenanceField[]> = {
	"model.id": ["model.id", "model.provider"],
	"model.configuration": ["model.configuration"],
	prompts: ["prompts", "subject.source.commit", "subject.definition_digest"],
	"subject.source.commit": ["subject.source.commit", "subject.definition_digest", "subject.version", "prompts"],
};

function provenance(m: Manifest, field: ProvenanceField): unknown {
	switch (field) {
		case "mode": return m.mode;
		case "subject.version": return m.subject.version;
		case "subject.definition_digest": return m.subject.definition_digest;
		case "subject.source.commit": return m.subject.source.commit;
		case "subject.source.dirty": return m.subject.source.dirty;
		case "prompts": return Object.fromEntries(m.prompts.map((p) => [p.step, p.digest]));
		case "model.provider": return m.model.provider;
		case "model.id": return m.model.id;
		case "model.configuration": return m.model.configuration;
		case "model.recordings_digest": return m.model.recordings_digest;
	}
}

export type Transition = "pass→pass" | "fail→fail" | "fixed" | "regressed" | "not-compared";

export interface CaseComparison {
	case: string;
	baseline: CaseStatus | "missing";
	candidate: CaseStatus | "missing";
	transition: Transition;
}

export interface ComparisonReport {
	/** False when the runs measured different things; nothing below is meaningful then. */
	comparable: boolean;
	reasons: string[];
	baseline: { run: string; mode: Mode; status: string };
	candidate: { run: string; mode: Mode; status: string };
	changes: { field: ProvenanceField; baseline: unknown; candidate: unknown }[];
	declared: Manifest["change"];
	/** Changed fields the declared variable does not cover. */
	undeclared: ProvenanceField[];
	/** True when the candidate changed more than it declared. */
	mismatch: boolean;
	notes: string[];
	cases: CaseComparison[];
	/** Errors, skips, and missing results are only ever in `not_compared`. EVL-001.7.4. */
	tally: { unchanged_pass: number; unchanged_fail: number; fixed: number; regressed: number; not_compared: number };
}

const TALLY_KEY = {
	"pass→pass": "unchanged_pass",
	"fail→fail": "unchanged_fail",
	fixed: "fixed",
	regressed: "regressed",
	"not-compared": "not_compared",
} as const;

/** Only pass and fail are compared; anything else is reported, never tallied as a result. */
function transitionOf(a: CaseStatus | "missing", b: CaseStatus | "missing"): Transition {
	if (a === "pass" && b === "pass") return "pass→pass";
	if (a === "fail" && b === "fail") return "fail→fail";
	if (a === "fail" && b === "pass") return "fixed";
	if (a === "pass" && b === "fail") return "regressed";
	return "not-compared";
}

const scorerSet = (m: Manifest) => m.scorers.map((s) => `${s.id}@${s.version}`).sort().join(",");

/** Compare two already-validated manifests. EVL-001.7. */
export function compareManifests(baseline: Manifest, candidate: Manifest): ComparisonReport {
	const reasons: string[] = [];
	if (baseline.standard !== candidate.standard) reasons.push(`standards differ: ${baseline.standard} vs ${candidate.standard}`);
	if (baseline.dataset.digest !== candidate.dataset.digest) {
		reasons.push(`dataset digests differ: ${baseline.dataset.id}@${baseline.dataset.revision} vs ${candidate.dataset.id}@${candidate.dataset.revision}`);
	}
	if (scorerSet(baseline) !== scorerSet(candidate)) reasons.push(`scorer sets differ: [${scorerSet(baseline)}] vs [${scorerSet(candidate)}]`);

	const changes = PROVENANCE_FIELDS.flatMap((field) => {
		const a = provenance(baseline, field);
		const b = provenance(candidate, field);
		return canonicalize(a) === canonicalize(b) ? [] : [{ field, baseline: a, candidate: b }];
	});
	const declared = candidate.change;
	const covered = declared ? CHANGE_COVERS[declared.variable] : [];
	const undeclared = changes.map((c) => c.field).filter((f) => !covered.includes(f));

	const notes: string[] = [];
	if (declared && declared.baseline !== baseline.run.id) notes.push(`candidate declares baseline ${declared.baseline}, compared against ${baseline.run.id}`);
	if (declared && !changes.some((c) => c.field === declared.variable)) notes.push(`declared variable ${declared.variable} did not change`);
	for (const [name, m] of [["baseline", baseline], ["candidate", candidate]] as const) {
		if (m.run.status !== "complete") notes.push(`${name} run is ${m.run.status}`);
	}

	const tally = { unchanged_pass: 0, unchanged_fail: 0, fixed: 0, regressed: 0, not_compared: 0 };
	const statusOf = (m: Manifest, id: string) => m.results.find((r) => r.case === id)?.status ?? "missing";
	const cases = reasons.length > 0 ? [] : baseline.dataset.cases.map((id): CaseComparison => {
		const a = statusOf(baseline, id);
		const b = statusOf(candidate, id);
		const transition = transitionOf(a, b);
		tally[TALLY_KEY[transition]]++;
		return { case: id, baseline: a, candidate: b, transition };
	});

	return {
		comparable: reasons.length === 0,
		reasons,
		baseline: { run: baseline.run.id, mode: baseline.mode, status: baseline.run.status },
		candidate: { run: candidate.run.id, mode: candidate.mode, status: candidate.run.status },
		changes,
		declared,
		undeclared,
		mismatch: undeclared.length > 0,
		notes,
		cases,
		tally,
	};
}
