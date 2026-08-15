import { homedir } from "node:os";
import { join } from "node:path";
import type { HarnessAdapter, TranscriptMetadata } from "../harness.ts";

// Claude Code: ~/.claude/projects/<mangled-cwd>/<session>.jsonl, with subagent
// sidechains at <session>/subagents/agent-<agentId>.jsonl.
//
// The format has NO header line — line 1 is a `user`, `mode`, `queue-operation`
// or title record, and session metadata (`sessionId`, `cwd`, `version`,
// `gitBranch`) is denormalized onto `user`/`assistant`/`attachment` records
// throughout the file. The scanner therefore reads forward and keeps the first
// value it sees for each field. Timestamps are NOT monotonic (queue and
// file-history writers interleave), so nothing here orders by time.
//
// The identity trap this adapter exists to fix: a subagent file carries the
// PARENT's `sessionId`. The first import pass used `sessionId` alone as the
// run identity and collapsed 1458 sidechain files onto ~542 sessions. Here the
// in-file `agentId` becomes `transcriptId`, so the file stays unique while
// `run` still groups it with its parent session.

const METADATA_FIELDS = ["sessionId", "cwd", "version", "gitBranch"] as const;

export const claudeAdapter: HarnessAdapter = {
	harness: "claude-code",
	mediaType: "application/x-ndjson",
	// A live Claude session appends to its own transcript, so a file imported
	// mid-session grows and returns with a new digest.
	appendOnly: true,
	// Claude's hooks expose no model request or response, and a reconstructed
	// transcript observes no live session or tool events. CLC-001.7.2.
	unsupported: ["session", "tool-call", "model-exchange", "patch", "commit-evidence"],

	defaultSource: (env) => env.CLAUDE_PROJECTS_DIR ?? join(homedir(), ".claude", "projects"),

	// No header to test, so detect by the record shape no other harness emits:
	// the uuid/parentUuid/sessionId triple. `parentUuid` is present-but-null on
	// the first real record, so `in` is the correct test, not truthiness. Title
	// stub files (`ai-title`/`agent-name` only) match the type fallback; they
	// are detected, then skipped later for having no run identity.
	detect(firstLines) {
		return firstLines.some((value) => {
			if (typeof value !== "object" || value === null) return false;
			const record = value as Record<string, unknown>;
			if ("uuid" in record && "parentUuid" in record && "sessionId" in record) return true;
			return ["user", "mode", "queue-operation", "ai-title", "custom-title", "started", "agent-name"].includes(
				record.type as string,
			);
		});
	},

	scanLine(value, meta) {
		if (typeof value !== "object" || value === null || Array.isArray(value)) return;
		const record = value as Record<string, unknown>;
		const scratch = meta as TranscriptMetadata & { sessionId?: string; version?: string };
		for (const field of METADATA_FIELDS) {
			if (scratch[field] === undefined && typeof record[field] === "string" && record[field].length > 0) {
				scratch[field] = record[field];
			}
		}
		// The subagent id lives in-file on sidechain records. It is the unique
		// per-file identity; the sessionId is the parent session's.
		if (meta.transcriptId === undefined && typeof record.agentId === "string" && record.agentId.length > 0) {
			meta.transcriptId = record.agentId;
		}
		// A resumed/forked session names the session it forked from.
		if (meta.parentRun === undefined && typeof record.parentSessionId === "string" && record.parentSessionId.length > 0) {
			meta.parentRun = record.parentSessionId;
		}
		// Claude declares no start time; the earliest record timestamp is the
		// only honest estimate, and min() — never first() — because timestamps
		// regress mid-file.
		if (typeof record.timestamp === "string" && (meta.startedAt === undefined || record.timestamp < meta.startedAt)) {
			meta.startedAt = record.timestamp;
		}
		// Map the Claude field names onto the neutral metadata.
		if (meta.run === undefined && scratch.sessionId !== undefined) meta.run = scratch.sessionId;
		if (meta.harnessVersion === undefined && scratch.version !== undefined) meta.harnessVersion = scratch.version;
	},

	toRecordFields(meta) {
		return {
			run: meta.run,
			// A top-level session file has no agentId; it is its own transcript.
			transcript_id: meta.transcriptId ?? meta.run,
			// Sixteen real sidechain files carry a parentSessionId that merely
			// echoes their own sessionId, and a run is not its own parent. The
			// guard lives here, not in scanLine, because parentSessionId can be
			// scanned before run settles.
			parent_run: meta.parentRun === meta.run ? null : (meta.parentRun ?? null),
			harness: "claude-code",
			harness_version: meta.harnessVersion ?? null,
			cwd: meta.cwd ?? null,
			started_at: meta.startedAt ?? null,
			git: { branch: meta.gitBranch ?? null, commit: null },
		};
	},
};
