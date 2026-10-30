import { canonicalize } from "./canonical.ts";
import type { CaseStatus, ChangeVariable, Manifest, Mode } from "./types.ts";

/** Provenance a comparison reports when it differs, field name → getter. EVL-001.7.2. */
const PROVENANCE = {
	"subject.version": (m: Manifest) => m.subject.version,
	"subject.definition_digest": (m: Manifest) => m.subject.definition_digest,
	"subject.source.commit": (m: Manifest) => m.subject.source.commit,
	"subject.source.dirty": (m: Manifest) => m.subject.source.dirty,
	"subject.source.paths": (m: Manifest) => m.subject.source.paths,
	prompts: (m: Manifest) => Object.fromEntries(m.prompts.map((p) => [p.step, p.digest])),
	"model.provider": (m: Manifest) => m.model.provider,
	"model.id": (m: Manifest) => m.model.id,
	"model.configuration": (m: Manifest) => m.model.configuration,
	"model.recordings_digest": (m: Manifest) => m.model.recordings_digest,
} as const;
export type ProvenanceField = keyof typeof PROVENANCE;

/**
 * Which differences each declared variable accounts for. EVL-001.7.3.
 * A prompt edit lands as a new commit, and workflow prompts live inside the
 * definition, so `prompts` covers both. Anything not listed is never covered.
 */
export const CHANGE_COVERS: Record<ChangeVariable, readonly ProvenanceField[]> = {
	"model.id": ["model.id", "model.provider"],
	"model.configuration": ["model.configuration"],
	prompts: ["prompts", "subject.source.commit", "subject.definition_digest"],
	"subject.source.commit": ["subject.source.commit", "subject.definition_digest", "subject.version", "prompts"],
};

/** What must be identical before two runs are compared at all. EVL-001.7.1. */
const IDENTITY: [string, (m: Manifest) => unknown][] = [
	["standard", (m) => m.standard],
	["mode", (m) => m.mode],
	["subject", (m) => [m.subject.kind, m.subject.id, m.subject.source.repository]],
	["dataset.digest", (m) => m.dataset.digest],
	["dataset.cases", (m) => m.dataset.cases],
	["scorers", (m) => m.scorers.map((s) => [s.id, s.version]).sort((a, b) => (canonicalize(a) < canonicalize(b) ? -1 : 1))],
];

export type Transition = "pass→pass" | "fail→fail" | "fixed" | "regressed" | "not-compared";

export interface CaseComparison {
	case: string;
	baseline: CaseStatus | "missing";
	candidate: CaseStatus | "missing";
	transition: Transition;
}

export interface ComparisonReport {
	/** False when the runs measured different things; then there are no cases and no tally. */
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

/** Compare two manifests that have already passed validation. EVL-001.7. */
export function compareManifests(baseline: Manifest, candidate: Manifest): ComparisonReport {
	const reasons = IDENTITY.flatMap(([name, get]) => {
		const a = canonicalize(get(baseline));
		const b = canonicalize(get(candidate));
		return a === b ? [] : [`${name} differs: ${a} vs ${b}`];
	});

	const changes = (Object.keys(PROVENANCE) as ProvenanceField[]).flatMap((field) => {
		const a = PROVENANCE[field](baseline);
		const b = PROVENANCE[field](candidate);
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
