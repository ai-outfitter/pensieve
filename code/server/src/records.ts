/** Record kinds the sink accepts. SRV-001.3.8. */
export const RECORD_KINDS = [
	"session",
	"commit-evidence",
	"transcript",
	"tool-call",
	"model-exchange",
	"patch",
	"image",
	"log",
	"network",
	"approval",
	"attestation",
	"sbom",
	"capture-failure",
	"derivation",
	"landing",
	"release-bundle",
] as const;

export type RecordKind = (typeof RECORD_KINDS)[number];

/** Where the collector that produced this record was installed. CLC-001.2.3. */
export const INSTALL_SCOPES = ["managed", "launcher", "user", "project", "session"] as const;
export type InstallScope = (typeof INSTALL_SCOPES)[number];

/** Only a managed installation is authoritative. CLC-001.2.4. */
export function isAuthoritativeScope(scope: InstallScope): boolean {
	return scope === "managed";
}

export interface PayloadRef {
	digest: string;
	media_type: string;
	size: number;
	locator: string;
}

export interface CaptureReport {
	profile: string;
	required: string[];
	captured: string[];
	/** Required classes the harness could not expose. CLC-001.4.4. */
	gaps: string[];
}

export interface BaseRecord {
	kind: RecordKind;
	run: string;
	attempt: number;
	identity: string;
	environment: string;
	policy_digest: string;
	created_at: string;
	install_scope?: InstallScope;
	harness?: string;
	payload?: PayloadRef;
	retention?: { payload: string; record: string };
	[key: string]: unknown;
}

export interface CommitEvidenceRecord extends BaseRecord {
	kind: "commit-evidence";
	sha: string;
	tree: string;
	parents: string[];
	/** Durable identity of the change; survives rebase and cherry-pick. SRV-001.4.2. */
	patch_id: string;
	segment: string[];
	capture: CaptureReport;
}

export type Attribution = "run" | "forge-generated" | "human" | "exempt" | "unattested";
export type Derivation =
	| "identical"
	| "squashed-from"
	| "rebased-from"
	| "cherry-picked-from"
	| "merge-of";

export interface LandedCommit {
	sha: string;
	attribution: Attribution;
	/** An exempt attribution must name the rule that grants it. SRV-001.7.4. */
	exempt_rule?: string;
	derivation?: Derivation;
	derived_from?: string[];
	evidence?: string[];
}

export interface LandingRecord extends BaseRecord {
	kind: "landing";
	ref: string;
	before: string;
	after: string;
	forced: boolean;
	landed: LandedCommit[];
	/** Content no derivation explains. SRV-001.7.9. */
	tree_delta?: { files: string[]; attributed_to: string };
	chain_break?: boolean;
	history_rewrite?: boolean;
	state?: "resolved" | "unattested-pending";
	resolution_deadline?: string;
}

export interface ReleaseBundleRecord extends BaseRecord {
	kind: "release-bundle";
	tag: string;
	from: string;
	commits: Array<{ sha: string; covered: boolean; evidence?: string; statements: string[] }>;
	uncovered: string[];
	gaps: string[];
	policy_digests: string[];
	identities: string[];
	fresh_until: string;
}

const REQUIRED_BASE = [
	"kind",
	"run",
	"attempt",
	"identity",
	"environment",
	"policy_digest",
	"created_at",
] as const;

export class RecordError extends Error {
	constructor(
		message: string,
		readonly status = 400,
	) {
		super(message);
	}
}

const SHA1 = /^[0-9a-f]{40}$/;
const ZERO_SHA = "0".repeat(40);

/**
 * A record missing a required field is rejected, never stored with a default.
 * SRV-001.3.6.
 */
export function validateRecord(input: unknown): BaseRecord {
	if (typeof input !== "object" || input === null || Array.isArray(input)) {
		throw new RecordError("record must be a JSON object");
	}
	const record = input as Record<string, unknown>;
	for (const field of REQUIRED_BASE) {
		if (record[field] === undefined || record[field] === null) {
			throw new RecordError(`record is missing required field "${field}"`);
		}
	}
	if (!RECORD_KINDS.includes(record.kind as RecordKind)) {
		throw new RecordError(`unknown record kind "${String(record.kind)}"`);
	}
	if (typeof record.attempt !== "number" || !Number.isInteger(record.attempt)) {
		throw new RecordError("attempt must be an integer");
	}
	if (record.install_scope !== undefined && !INSTALL_SCOPES.includes(record.install_scope as InstallScope)) {
		throw new RecordError(`unknown install_scope "${String(record.install_scope)}"`);
	}
	if (record.payload !== undefined) validatePayloadRef(record.payload);

	switch (record.kind) {
		case "commit-evidence":
			validateCommitEvidence(record);
			break;
		case "landing":
			validateLanding(record);
			break;
		case "release-bundle":
			validateReleaseBundle(record);
			break;
		default:
			break;
	}
	return record as BaseRecord;
}

function validatePayloadRef(value: unknown): void {
	if (typeof value !== "object" || value === null) throw new RecordError("payload must be an object");
	const payload = value as Record<string, unknown>;
	for (const field of ["digest", "media_type", "size", "locator"]) {
		if (payload[field] === undefined) throw new RecordError(`payload is missing "${field}"`);
	}
	if (typeof payload.digest !== "string" || !/^[0-9a-f]{64}$/.test(payload.digest)) {
		throw new RecordError("payload.digest must be a sha256 hex digest");
	}
}

function validateCommitEvidence(record: Record<string, unknown>): void {
	for (const field of ["sha", "tree", "parents", "patch_id", "segment", "capture"]) {
		if (record[field] === undefined) throw new RecordError(`commit-evidence is missing "${field}"`);
	}
	if (typeof record.sha !== "string" || !SHA1.test(record.sha)) {
		throw new RecordError("commit-evidence.sha must be a 40-character hex SHA");
	}
	const capture = record.capture as CaptureReport | undefined;
	if (!capture || !Array.isArray(capture.required) || !Array.isArray(capture.gaps)) {
		throw new RecordError("commit-evidence.capture must declare required and gaps");
	}
}

/**
 * An unmet required class seals the record failed-evidence. SRV-001.4.5.
 *
 * Derived on read rather than written onto the record: validation must not
 * edit the document it is validating, or the bytes the sink stores are not the
 * bytes the collector composed and no collector could precompute its own
 * record digest.
 */
export function sealStatus(capture: CaptureReport): "sealed" | "failed-evidence" {
	return capture.gaps.length > 0 ? "failed-evidence" : "sealed";
}

function validateLanding(record: Record<string, unknown>): void {
	for (const field of ["ref", "before", "after", "landed"]) {
		if (record[field] === undefined) throw new RecordError(`landing is missing "${field}"`);
	}
	if (typeof record.after !== "string" || !SHA1.test(record.after)) {
		throw new RecordError("landing.after must be a 40-character hex SHA");
	}
	// Ref creation carries the zero object as `before`. SRV-001.7.12.
	if (typeof record.before !== "string" || (!SHA1.test(record.before) && record.before !== ZERO_SHA)) {
		throw new RecordError("landing.before must be a hex SHA or the zero object");
	}
	if (!Array.isArray(record.landed)) throw new RecordError("landing.landed must be an array");
	for (const entry of record.landed as LandedCommit[]) {
		if (entry.attribution === "exempt" && !entry.exempt_rule) {
			throw new RecordError(`landed commit ${entry.sha} is exempt but names no rule`);
		}
	}
}

function validateReleaseBundle(record: Record<string, unknown>): void {
	for (const field of ["tag", "from", "commits", "fresh_until"]) {
		if (record[field] === undefined) throw new RecordError(`release-bundle is missing "${field}"`);
	}
	if (!Array.isArray(record.commits)) throw new RecordError("release-bundle.commits must be an array");
}
