import { describe, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectTranscript } from "../transcript.ts";
import { piAdapter } from "./pi.ts";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "test", "fixtures");
const piSession = join(fixtures, "pi-session.jsonl");

const PI_HEADER = {
	type: "session",
	version: 3,
	id: "01990000-0000-7000-8000-0000000f1c70",
	timestamp: "2026-08-12T09:30:00.000Z",
	cwd: "/home/example/project",
};

describe("pi detection", () => {
	test("claims a pi header line", () => {
		expect(piAdapter.detect([PI_HEADER])).toBe(true);
	});

	test("rejects a Codex header line", () => {
		expect(piAdapter.detect([{ timestamp: "2026-08-12T09:30:00.000Z", type: "session_meta", payload: { id: "x" } }])).toBe(
			false,
		);
	});

	test("rejects a Claude record", () => {
		expect(piAdapter.detect([{ uuid: "x", parentUuid: null, sessionId: "y", type: "user" }])).toBe(false);
	});

	// THE FOUR-FIELD CHECK IS THE REQUIREMENT, NOT AN OPTIMIZATION
	// `type:"session"` is a common enough word that a bare match is not an
	// identity claim; a header with no numeric version and no cwd is not pi.
	test("rejects a loose session object with no version or cwd", () => {
		expect(piAdapter.detect([{ type: "session" }])).toBe(false);
	});

	test("rejects a header whose version is a string", () => {
		expect(piAdapter.detect([{ ...PI_HEADER, version: "3" }])).toBe(false);
	});
});

describe("pi metadata scan", () => {
	test("reads the whole identity from the header line", async () => {
		const result = await inspectTranscript(piSession, [piAdapter]);
		expect(result.harness).toBe("pi");
		expect(result.skipReason).toBeUndefined();
		expect(result.malformedLines).toBe(0);
		// pi writes no subagent files, so the file is its own transcript.
		expect(result.metadata.run).toBe(PI_HEADER.id);
		expect(result.metadata.transcriptId).toBe(PI_HEADER.id);
		expect(result.metadata.run).toBe(result.metadata.transcriptId as string);
		expect(result.metadata.parentRun).toBeUndefined();
		expect(result.metadata.cwd).toBe(PI_HEADER.cwd);
		expect(result.metadata.startedAt).toBe(PI_HEADER.timestamp);
	});

	// THIS TEST VALIDATES A HARD REQUIREMENT
	// YOU MUST NOT MODIFY THIS TEST UNLESS THE REQUIREMENT CHANGES
	// `version: 3` is the transcript SCHEMA version. pi records no harness
	// version anywhere, so mapping it here would publish a false attribution.
	test("does not leak the schema version into harnessVersion", async () => {
		const result = await inspectTranscript(piSession, [piAdapter]);
		expect(result.metadata.harnessVersion).toBeUndefined();
		expect(result.metadata.gitBranch).toBeUndefined();
		expect(result.metadata.gitCommit).toBeUndefined();
	});

	test("keeps the first header when a second one appears", () => {
		const meta = {};
		piAdapter.scanLine(PI_HEADER, meta);
		piAdapter.scanLine({ ...PI_HEADER, id: "second", cwd: "/other", timestamp: "2027-01-01T00:00:00.000Z" }, meta);
		expect(meta).toEqual({
			run: PI_HEADER.id,
			transcriptId: PI_HEADER.id,
			cwd: PI_HEADER.cwd,
			startedAt: PI_HEADER.timestamp,
		});
	});

	test("ignores every non-session record type", () => {
		const meta = {};
		for (const record of [
			{ type: "model_change", id: "a", provider: "p", modelId: "m", timestamp: "2026-08-12T09:30:01.000Z" },
			{ type: "message", id: "b", message: { role: "user", content: [] }, timestamp: "2026-08-12T09:30:05.000Z" },
			{ type: "custom", customType: "example:fixture-mode", data: {}, timestamp: "2026-08-12T09:30:06.000Z" },
			"not an object",
			null,
			[1, 2, 3],
		]) {
			piAdapter.scanLine(record, meta);
		}
		expect(meta).toEqual({});
	});
});

describe("pi record fields", () => {
	test("emits the neutral record shape with honest nulls", async () => {
		const result = await inspectTranscript(piSession, [piAdapter]);
		expect(piAdapter.toRecordFields(result.metadata)).toEqual({
			run: PI_HEADER.id,
			transcript_id: PI_HEADER.id,
			parent_run: null,
			harness: "pi",
			harness_version: null,
			cwd: PI_HEADER.cwd,
			started_at: PI_HEADER.timestamp,
			git: { branch: null, commit: null },
		});
	});
});
