import { homedir } from "node:os";
import { join } from "node:path";
import { firstParsed, type HarnessAdapter, type TranscriptMetadata } from "../harness.ts";

// Codex CLI: ~/.codex/sessions/YYYY/MM/DD/rollout-<iso>-<rolloutId>.jsonl.
//
// Unlike Claude, Codex writes a HEADER: line 1 is always
// `{"timestamp":…,"type":"session_meta","payload":{…}}`, and every identity
// field this adapter needs lives in that one payload. Later lines are
// `response_item`, `event_msg`, `turn_context` and friends, none of which
// carry session identity.
//
// The identity trap here is the mirror of Claude's. `payload.id` is the
// ROLLOUT id — unique per file, equal to the uuid in the filename — while
// `payload.session_id` is the THREAD id that several rollouts share when a
// session is resumed. Keying `run` on `id` would split one thread into as
// many runs as it has rollout files, so `run` prefers `session_id` and falls
// back to `id` on 2025-era files, which predate the field.
//
// Two more facts about the payload, both verified across the 1293 local
// rollouts and both able to crash a naive reader:
//
// - `source` is polymorphic: the string "cli"/"exec" on older and top-level
//   sessions, an object like {"subagent":{…}} on the 659 subagent rollouts.
//   Nothing here reads it; nothing here may assume it is a string.
// - `git` is absent in 124 files, `{}` in 30, and missing `branch` in 64, so
//   every level is typechecked rather than assumed.
//
// A RESUMED session re-emits `session_meta` mid-file with the resumed
// rollout's values. Only the FIRST header describes the file that was
// written, so the scanner takes the first one whole and ignores the rest —
// per-field first-wins would splice a later header's `parent_thread_id` onto
// the first header's ids.

/** Read `key` from `payload` when it holds a non-empty string. */
function text(payload: Record<string, unknown>, key: string): string | undefined {
	const value = payload[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** The header payload of a `session_meta` line, or undefined for any other line. */
function sessionMeta(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const record = value as Record<string, unknown>;
	if (record.type !== "session_meta") return undefined;
	const payload = record.payload;
	if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
	return payload as Record<string, unknown>;
}

export const codexAdapter: HarnessAdapter = {
	harness: "codex",
	mediaType: "application/x-ndjson",
	// A live rollout is appended to as the session runs, so a file imported
	// mid-session grows and returns with a new digest.
	appendOnly: true,
	// A reconstructed rollout observes no live session or tool events, and a
	// conversation transcript is not a model exchange. CLC-001.7.2.
	unsupported: ["session", "tool-call", "model-exchange", "patch", "commit-evidence"],

	defaultSource: (env) => env.CODEX_SESSIONS_DIR ?? join(homedir(), ".codex", "sessions"),

	// Line 1 is the discriminator and the only line that can claim the file:
	// no Claude record and no pi header carries `type:"session_meta"` with an
	// object payload.
	detect(firstLines) {
		const first = firstParsed(firstLines);
		return first !== undefined && sessionMeta(first) !== undefined;
	},

	scanLine(value, meta) {
		const payload = sessionMeta(value);
		if (payload === undefined) return;
		// First header wins, whole. `id` is present on every real header, so
		// this is the reliable "already scanned one" flag.
		if (meta.transcriptId !== undefined) return;

		const id = text(payload, "id");
		meta.transcriptId = id;
		// 2025-era rollouts have no `session_id`; the rollout id is then the
		// only thread identity there is.
		meta.run = text(payload, "session_id") ?? id;
		// A subagent thread names its caller; a forked session names its
		// origin. A resumed rollout repeats its OWN thread id here, and a run
		// is not its own parent, so an echo of `run` is dropped.
		const parent = text(payload, "parent_thread_id") ?? text(payload, "forked_from_id");
		if (parent !== undefined && parent !== meta.run) meta.parentRun = parent;

		meta.cwd = text(payload, "cwd");
		meta.harnessVersion = text(payload, "cli_version");
		// The payload timestamp is when the session STARTED. The enclosing
		// line's timestamp is when the header was written, and the two differ
		// in every one of the 1293 local rollouts.
		meta.startedAt = text(payload, "timestamp");

		const git = payload.git;
		if (typeof git === "object" && git !== null && !Array.isArray(git)) {
			const repository = git as Record<string, unknown>;
			meta.gitBranch = text(repository, "branch");
			meta.gitCommit = text(repository, "commit_hash");
		}
	},

	toRecordFields(meta: TranscriptMetadata) {
		return {
			run: meta.run,
			// The rollout id, unique per file even when several rollouts share
			// one thread.
			transcript_id: meta.transcriptId ?? meta.run,
			parent_run: meta.parentRun ?? null,
			harness: "codex",
			harness_version: meta.harnessVersion ?? null,
			cwd: meta.cwd ?? null,
			started_at: meta.startedAt ?? null,
			// Codex records the commit its session started on; Claude does not.
			git: { branch: meta.gitBranch ?? null, commit: meta.gitCommit ?? null },
		};
	},
};
