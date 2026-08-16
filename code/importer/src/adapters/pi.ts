import { homedir } from "node:os";
import { join } from "node:path";
import { firstParsed, type HarnessAdapter } from "../harness.ts";

// pi: ~/.pi/agent/sessions/<mangled-cwd>/<timestamp>_<sessionId>.jsonl.
//
// Unlike Claude, pi opens every transcript with a header line carrying the
// whole session identity — `{type:"session", version, id, timestamp, cwd}` —
// and nothing after it repeats those fields. Line 1 is therefore the only line
// the scanner needs; every later record type (`message`, `model_change`,
// `thinking_level_change`, `custom_message`, `custom`) is payload it must pass
// over without error.
//
// Two things this adapter deliberately does NOT do:
//
// - It never reads the mangled parent directory name. That name is a lossy
//   encoding of a project root, not of the working directory; the in-file
//   `cwd` is authoritative and is the only source used.
// - It never maps `version` onto `harnessVersion`. `version: 3` is the
//   TRANSCRIPT SCHEMA version, not the pi release that wrote the file. pi
//   records no harness version anywhere, so `harness_version` is honestly
//   null rather than confidently wrong. Same reasoning for git: pi records no
//   branch and no commit, so both stay null and neither is inferred.
//
// pi writes no subagent transcript files, so a file is its own transcript:
// `run` and `transcriptId` are both the session id, and `parentRun` is unset.

export const piAdapter: HarnessAdapter = {
	harness: "pi",
	mediaType: "application/x-ndjson",
	// A live pi session appends to its own transcript, so a file imported
	// mid-session grows and returns with a new digest.
	appendOnly: true,
	// A reconstructed transcript observes no live session, tool, or model
	// events, and carries no patch or commit evidence. CLC-001.7.2.
	unsupported: ["session", "tool-call", "model-exchange", "patch", "commit-evidence"],

	defaultSource: (env) => env.PI_SESSIONS_DIR ?? join(homedir(), ".pi", "agent", "sessions"),

	// Detect on the header line only, and on all four of its fields. Codex
	// opens with `type:"session_meta"` and Claude has no header at all, but
	// `type:"session"` alone is still too loose to be an identity claim — a
	// header without a numeric `version`, a string `id` and a string `cwd` is
	// not a pi transcript, and guessing would write a wrong attribution into a
	// store that cannot correct it. CLC-001.4.4.
	detect(firstLines) {
		const header = firstParsed(firstLines);
		if (header === undefined) return false;
		return (
			header.type === "session" &&
			typeof header.version === "number" &&
			typeof header.id === "string" &&
			typeof header.cwd === "string"
		);
	},

	scanLine(value, meta) {
		if (typeof value !== "object" || value === null || Array.isArray(value)) return;
		const record = value as Record<string, unknown>;
		if (record.type !== "session") return;
		// First-seen wins, so a second header line (which no observed file has,
		// but a concatenated or resumed one could) cannot rewrite the identity.
		if (meta.run === undefined && typeof record.id === "string" && record.id.length > 0) {
			meta.run = record.id;
			// No subagent files: the session id is also the unique file identity.
			meta.transcriptId = record.id;
		}
		if (meta.cwd === undefined && typeof record.cwd === "string" && record.cwd.length > 0) {
			meta.cwd = record.cwd;
		}
		// pi declares its start time in the header, so this is a stated value,
		// not the earliest-timestamp estimate Claude forces.
		if (meta.startedAt === undefined && typeof record.timestamp === "string" && record.timestamp.length > 0) {
			meta.startedAt = record.timestamp;
		}
	},

	toRecordFields(meta) {
		return {
			run: meta.run,
			transcript_id: meta.transcriptId ?? meta.run,
			parent_run: meta.parentRun ?? null,
			harness: "pi",
			// Never set by scanLine — see the note on `version` above.
			harness_version: meta.harnessVersion ?? null,
			cwd: meta.cwd ?? null,
			started_at: meta.startedAt ?? null,
			git: { branch: null, commit: null },
		};
	},
};
