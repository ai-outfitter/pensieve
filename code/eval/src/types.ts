/** The bundle standard this package reads and writes. EVL-001.1.3. */
export const STANDARD = "pensieve.evaluation/v0";

export const RUN_STATUSES = ["running", "complete", "failed", "interrupted"] as const;
export const MODES = ["recorded", "real-model", "live-provider"] as const;
export const SCORER_KINDS = ["deterministic", "judge", "human"] as const;
export const MODEL_KINDS = ["recorded", "provider"] as const;
export const CASE_STATUSES = ["pass", "fail", "error", "skipped"] as const;
export const CHECK_STATUSES = ["pass", "fail", "error", "not-applicable", "pending"] as const;
export const CHANGE_VARIABLES = ["model.id", "prompts", "subject.source.commit", "model.configuration"] as const;

export type RunStatus = (typeof RUN_STATUSES)[number];
export type Mode = (typeof MODES)[number];
export type CaseStatus = (typeof CASE_STATUSES)[number];
export type CheckStatus = (typeof CHECK_STATUSES)[number];
export type ChangeVariable = (typeof CHANGE_VARIABLES)[number];

export interface Run {
	id: string;
	attempt: number;
	status: RunStatus;
	started_at: string;
	ended_at: string | null;
	/** Earlier attempt or rerun this one follows. */
	previous: string | null;
	/** A regrade re-scores saved outputs of another run; it never edits it. */
	regrade_of: string | null;
}

export interface Subject {
	kind: string;
	id: string;
	version: string;
	definition_digest: string;
	source: { repository: string; commit: string; dirty: boolean; paths: string[] };
}

export interface Dataset {
	id: string;
	revision: string;
	digest: string;
	cases: string[];
}

export interface Scorer {
	id: string;
	version: string;
	kind: (typeof SCORER_KINDS)[number];
}

export interface Model {
	kind: (typeof MODEL_KINDS)[number];
	provider: string | null;
	id: string | null;
	configuration: Record<string, unknown>;
	recordings_digest: string | null;
}

export interface Prompt {
	step: string;
	digest: string;
	path: string;
}

export interface Change {
	variable: ChangeVariable;
	baseline: string;
	description: string;
}

export interface Check {
	scorer: string;
	status: CheckStatus;
	reason?: string;
}

export interface CaseResult {
	case: string;
	status: CaseStatus;
	checks: Check[];
	artifacts: string[];
}

export interface Gap {
	case: string | null;
	class: string;
	reason: string;
}

export interface Summary {
	cases: number;
	pass: number;
	fail: number;
	error: number;
	skipped: number;
}

export interface Artifact {
	path: string;
	digest: string;
	size: number;
	media_type: string;
}

export interface Manifest {
	standard: typeof STANDARD;
	run: Run;
	mode: Mode;
	subject: Subject;
	dataset: Dataset;
	scorers: Scorer[];
	model: Model;
	prompts: Prompt[];
	change: Change | null;
	results: CaseResult[];
	gaps: Gap[];
	summary: Summary;
	artifacts: Artifact[];
}

/** Optional, kept outside the manifest so a statement over it causes no digest cycle. EVL-001.5. */
export interface Receipt {
	manifest_digest: string;
	statements: unknown[];
}

/** One validation failure: which file, which field, what is wrong. */
export interface Issue {
	file: string;
	field?: string;
	message: string;
}

export interface ValidationReport {
	valid: boolean;
	run: string | null;
	mode: Mode | null;
	status: RunStatus | null;
	issues: Issue[];
}

export const MANIFEST_FILE = "manifest.json";
export const RECEIPT_FILE = "receipt.json";
