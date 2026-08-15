import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { TranscriptMetadata } from "../harness.ts";
import { inspectTranscript } from "../transcript.ts";
import { codexAdapter } from "./codex.ts";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "test", "fixtures");
const codexSession = join(fixtures, "codex-session.jsonl");

/** A 2025-era header: no session_id, a STRING source, and no git object at all. */
const legacyHeader = {
	timestamp: "2025-11-19T20:08:36.552Z",
	type: "session_meta",
	payload: {
		id: "01999999-0000-7000-8000-eeeeeeeeeeee",
		timestamp: "2025-11-19T20:08:36.547Z",
		cwd: "/work/legacy",
		originator: "codex_cli_rs",
		cli_version: "0.53.0",
		source: "cli",
	},
};

describe("codex detection", () => {
	test("claims a session_meta header and nothing else", async () => {
		const [header] = (await Bun.file(codexSession).text()).split("\n");
		expect(codexAdapter.detect([JSON.parse(header ?? "")])).toBe(true);
		expect(codexAdapter.detect([legacyHeader])).toBe(true);
		// Claude has no header; its first record is a plain conversation record.
		expect(codexAdapter.detect([{ uuid: "x", parentUuid: null, sessionId: "y", type: "user" }])).toBe(false);
		// pi opens with its own header, discriminated by type:"session".
		expect(
			codexAdapter.detect([{ type: "session", version: 3, id: "z", timestamp: "2026-08-12T00:00:00Z", cwd: "/x" }]),
		).toBe(false);
		// The type alone is not enough: the payload must be an object.
		expect(codexAdapter.detect([{ type: "session_meta", payload: "cli" }])).toBe(false);
		expect(codexAdapter.detect([])).toBe(false);
	});
});

describe("codex metadata", () => {
	test("takes thread identity from the first header and ignores a resumed one", async () => {
		const result = await inspectTranscript(codexSession, [codexAdapter]);

		expect(result.harness).toBe("codex");
		expect(result.skipReason).toBeUndefined();
		// THIS TEST VALIDATES A HARD REQUIREMENT (CLC-001.1.7 identity)
		// `run` must be the THREAD id, not the rollout id: keying on `id` splits
		// one resumed thread into one run per rollout file.
		expect(result.metadata).toEqual({
			run: "00000000-1111-7000-8000-aaaaaaaaaaaa",
			transcriptId: "00000000-2222-7000-8000-bbbbbbbbbbbb",
			parentRun: "00000000-3333-7000-8000-cccccccccccc",
			cwd: "/work/fixture-repo",
			harnessVersion: "0.147.0",
			gitBranch: "feat/fixture",
			gitCommit: "1111111111111111111111111111111111111111",
			startedAt: "2026-08-12T09:15:00.204Z",
		});
		// The fixture's mid-file session_meta carries a different value for every
		// field, so any leak from it would show above. Stated once more for the
		// fields most likely to be spliced in by a per-field first-wins scan.
		expect(result.metadata.cwd).not.toBe("/work/resumed-elsewhere");
		expect(result.metadata.harnessVersion).not.toBe("9.99.9");
		// The session START time, never the line's write time.
		expect(result.metadata.startedAt).not.toBe("2026-08-12T09:15:02.881Z");
	});

	test("drops a parent_thread_id that only echoes the run", () => {
		// A resumed rollout repeats its own thread id here. `parentRun` names a
		// DIFFERENT run or nothing at all.
		const meta: TranscriptMetadata = {};
		codexAdapter.scanLine(
			{
				type: "session_meta",
				payload: { id: "rollout-2", session_id: "thread-1", parent_thread_id: "thread-1", cwd: "/work" },
			},
			meta,
		);
		expect(meta.run).toBe("thread-1");
		expect(meta.parentRun).toBeUndefined();
	});

	test("falls back to forked_from_id when there is no parent thread", () => {
		const meta: TranscriptMetadata = {};
		codexAdapter.scanLine(
			{ type: "session_meta", payload: { id: "rollout-3", session_id: "thread-2", forked_from_id: "thread-1" } },
			meta,
		);
		expect(meta.parentRun).toBe("thread-1");
	});

	test("reads a 2025-era header with no session_id, no git, and a string source", () => {
		const meta: TranscriptMetadata = {};
		codexAdapter.scanLine(legacyHeader, meta);

		// Before `session_id` existed the rollout id was the only thread identity.
		expect(meta.run).toBe("01999999-0000-7000-8000-eeeeeeeeeeee");
		expect(meta.transcriptId).toBe(meta.run);
		expect(meta.parentRun).toBeUndefined();
		expect(meta.gitBranch).toBeUndefined();
		expect(meta.gitCommit).toBeUndefined();

		expect(codexAdapter.toRecordFields(meta)).toEqual({
			run: "01999999-0000-7000-8000-eeeeeeeeeeee",
			transcript_id: "01999999-0000-7000-8000-eeeeeeeeeeee",
			parent_run: null,
			harness: "codex",
			harness_version: "0.53.0",
			cwd: "/work/legacy",
			started_at: "2025-11-19T20:08:36.547Z",
			git: { branch: null, commit: null },
		});
	});

	test("survives a git object that is empty or missing its branch", () => {
		const empty: TranscriptMetadata = {};
		codexAdapter.scanLine({ type: "session_meta", payload: { id: "a", git: {} } }, empty);
		expect(empty.gitBranch).toBeUndefined();
		expect(empty.gitCommit).toBeUndefined();

		const detached: TranscriptMetadata = {};
		codexAdapter.scanLine({ type: "session_meta", payload: { id: "b", git: { commit_hash: "abc" } } }, detached);
		expect(detached.gitBranch).toBeUndefined();
		expect(detached.gitCommit).toBe("abc");
	});
});

describe("codex record fields", () => {
	test("emits exactly the harness-owned fields", async () => {
		const { metadata } = await inspectTranscript(codexSession, [codexAdapter]);
		const fields = codexAdapter.toRecordFields(metadata);

		expect(Object.keys(fields).sort()).toEqual([
			"cwd",
			"git",
			"harness",
			"harness_version",
			"parent_run",
			"run",
			"started_at",
			"transcript_id",
		]);
		expect(fields).toEqual({
			run: "00000000-1111-7000-8000-aaaaaaaaaaaa",
			transcript_id: "00000000-2222-7000-8000-bbbbbbbbbbbb",
			parent_run: "00000000-3333-7000-8000-cccccccccccc",
			harness: "codex",
			harness_version: "0.147.0",
			cwd: "/work/fixture-repo",
			started_at: "2026-08-12T09:15:00.204Z",
			git: { branch: "feat/fixture", commit: "1111111111111111111111111111111111111111" },
		});
	});
});
