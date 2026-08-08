/** Where the collector was installed. Recorded on every session record. CLC-001.2.3. */
export const INSTALL_SCOPES = ["managed", "launcher", "user", "project", "session"] as const;
export type InstallScope = (typeof INSTALL_SCOPES)[number];

export type RecordKind =
	| "session"
	| "commit-evidence"
	| "transcript"
	| "tool-call"
	| "model-exchange"
	| "patch"
	| "log"
	| "capture-failure"
	| "derivation";

export interface CaptureProfile {
	name: string;
	/** Artifact classes this profile requires. CLC-001.4.1. */
	required: RecordKind[];
	/**
	 * Classes this harness cannot expose. Declared up front rather than
	 * discovered by their absence. CLC-001.4.4.
	 */
	unsupported: RecordKind[];
}

export interface CollectorContext {
	run: string;
	attempt: number;
	identity: string;
	environment: string;
	policy_digest: string;
	install_scope: InstallScope;
	harness: string;
	harness_version: string;
	/** The event surface actually used, so coverage is computed, not asserted. CLC-001.7.4. */
	event_surface: string;
	profile: CaptureProfile;
	cwd: string;
}

export interface EvidenceRecord {
	kind: RecordKind;
	run: string;
	attempt: number;
	identity: string;
	environment: string;
	policy_digest: string;
	created_at: string;
	install_scope: InstallScope;
	harness: string;
	[key: string]: unknown;
}

export interface CommitInfo {
	sha: string;
	tree: string;
	parents: string[];
	patch_id: string;
}
