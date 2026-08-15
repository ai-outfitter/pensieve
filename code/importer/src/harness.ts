// The per-harness surface of the importer, mirroring the collector convention:
// a plain options object supplied at the import site, no registry, no lookup
// table keyed on harness name. A new harness is a new adapter file and an
// import statement — shared code never changes to describe it. CLC-001.1.7.
//
// Everything not in this interface is engine and MUST stay harness-neutral:
// the streaming hasher, the checkpoint state machine, the concurrency pool,
// the sink client, and the abort semantics.

/**
 * Record classes a reconstructed import cannot supply, declared per adapter
 * and written into every record's capture report. A conversation transcript
 * MUST NOT be recorded as satisfying `model-exchange` (CLC-001.7.2), and an
 * import observes no live events, so the classes a live collector captures
 * are gaps here. Values come from the server's RECORD_KINDS vocabulary —
 * the 16-kind list in `server/src/records.ts`, not collector-core's copy,
 * which has drifted to 9.
 */
export type GapClass = "session" | "tool-call" | "model-exchange" | "patch" | "commit-evidence";

/**
 * What one transcript file claims about itself, filled in by an adapter's
 * line scanner. Identity is composite — this is the correction for the first
 * import pass, which mapped 1458 Claude subagent files onto their parents'
 * session ids, all `attempt: 1`, indistinguishable and immutable:
 *
 * - `run` GROUPS transcripts: the session or thread the work belongs to.
 *   A Claude subagent shares its parent's `run` on purpose.
 * - `transcriptId` is UNIQUE per file: the agent id for a Claude subagent,
 *   the rollout id for Codex, the session id where a harness has no
 *   subagent files.
 * - `parentRun` names a DIFFERENT run this one descends from (a Codex
 *   subagent thread, a forked session). Null when there is none; never a
 *   copy of `run`.
 */
export interface TranscriptMetadata {
	run?: string;
	transcriptId?: string;
	parentRun?: string;
	cwd?: string;
	harnessVersion?: string;
	gitBranch?: string;
	gitCommit?: string;
	startedAt?: string;
}

export interface HarnessAdapter {
	/** Harness name recorded on every record. CLC-001.2.5. */
	harness: string;
	/** Payload media type for the upload. */
	mediaType: string;
	/**
	 * Whether this harness appends to a live transcript in place. Only an
	 * append-only harness gets the grew-since-import supersedes handling —
	 * for a harness that rotates or rewrites files, that logic would be
	 * wrong, not merely unused.
	 */
	appendOnly: boolean;
	/** Classes reconstruction cannot supply. CLC-001.7.2, CLC-001.4.4. */
	unsupported: GapClass[];
	/** Where this harness keeps transcripts when no --source is given. */
	defaultSource(env: Record<string, string | undefined>): string;
	/**
	 * Whether a file is this harness's, judged from its first parsed lines —
	 * by content, never by path. The three formats are mutually exclusive:
	 * Codex opens with `type:"session_meta"`, pi with `type:"session"`, and
	 * Claude has no header at all, only per-record metadata keys.
	 */
	detect(firstLines: unknown[]): boolean;
	/**
	 * Streaming line visitor: fold one parsed JSONL value into the metadata.
	 * Called once per line, in file order, during the same single pass that
	 * hashes the raw bytes — it must not read the file itself.
	 */
	scanLine(value: unknown, meta: TranscriptMetadata): void;
	/**
	 * Harness-specific record fields, merged into the engine's base record.
	 * The engine owns kind, attempt, identity, environment, policy_digest,
	 * created_at, provenance, observed, the imported-from fields, payload,
	 * capture, and supersedes.
	 */
	toRecordFields(meta: TranscriptMetadata): Record<string, unknown>;
}

/** First parsed line of the file, or undefined when it does not parse. */
export function firstParsed(firstLines: unknown[]): Record<string, unknown> | undefined {
	const value = firstLines[0];
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}
