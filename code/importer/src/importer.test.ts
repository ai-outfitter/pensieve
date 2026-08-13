import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { importTranscripts, type ImportOptions, type ImportSink } from "./importer.ts";
import { inspectTranscript } from "./transcript.ts";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "test", "fixtures");

describe("transcript inspection", () => {
	test("scans across lines for metadata and ignores malformed JSON", async () => {
		const result = await inspectTranscript(join(fixtures, "metadata-across-lines.jsonl"));
		expect(result.metadata).toEqual({
			sessionId: "session-fixture",
			cwd: "/work/example",
			version: "1.2.3",
			gitBranch: "feat/importer",
		});
		expect(result.malformedLines).toBe(1);
		expect(result.skipReason).toBeUndefined();
		expect(result.digest).toMatch(/^[0-9a-f]{64}$/);
	});

	test("skips malformed logs with no sessionId", async () => {
		const result = await inspectTranscript(join(fixtures, "malformed-only.jsonl"));
		expect(result.skipReason).toBe("missing-session-id");
		expect(result.malformedLines).toBe(2);
	});

	test("skips a file above the upload threshold before reading it", async () => {
		const result = await inspectTranscript(join(fixtures, "metadata-across-lines.jsonl"), 1);
		expect(result.skipReason).toBe("too-large");
		expect(result.digest).toBeUndefined();
	});
});

describe("import idempotency", () => {
	test("checkpoints only an accepted record and skips its digest on rerun", async () => {
		const root = await mkdtemp(join(tmpdir(), "pensieve-importer-"));
		const source = join(root, "projects", "demo");
		await Bun.write(join(source, "session.jsonl"), await readFile(join(fixtures, "metadata-across-lines.jsonl")));
		const statePath = join(root, "state", "imports.json");
		const calls = { uploads: 0, records: [] as Array<Record<string, unknown>> };
		const sink: ImportSink = {
			async upload(_path, digest, size) {
				calls.uploads += 1;
				return { digest, size, media_type: "application/x-ndjson", locator: `memory:${digest}` };
			},
			async postRecord(record) {
				calls.records.push(record);
				return { digest: "f".repeat(64) };
			},
		};
		const options: ImportOptions = {
			sink: "https://sink.invalid", token: "secret", identity: "agent:test-workstation",
			source: join(root, "projects"), dryRun: false, concurrency: 2, statePath,
			now: () => new Date("2026-08-11T12:00:00.000Z"),
		};

		const first = await importTranscripts(options, sink);
		expect(first.imported).toBe(1);
		expect(calls.uploads).toBe(1);
		expect(calls.records).toHaveLength(1);
		expect(calls.records[0]).toMatchObject({
			identity: "agent:test-workstation", provenance: "imported", observed: false,
			imported_from: join(source, "session.jsonl"), imported_at: "2026-08-11T12:00:00.000Z",
			harness: "claude-code", harness_version: "1.2.3", cwd: "/work/example",
			git_branch: "feat/importer",
		});
		expect(calls.records[0]).not.toHaveProperty("install_scope");

		const second = await importTranscripts(options, sink);
		expect(second.skipped).toBe(1);
		expect(second.decisions[0]?.reason).toBe("payload digest already imported");
		expect(calls.uploads).toBe(1);
		expect(calls.records).toHaveLength(1);
		const saved = JSON.parse(await readFile(statePath, "utf8"));
		expect(saved).toHaveProperty("version", 1);
		// The record digest is the only key GET /v0/records accepts, and the sink
		// returns it exactly once. A checkpoint that drops it leaves the record
		// unaddressable forever, which is how the first 2001 imports were lost to
		// lookup.
		expect(Object.values(saved.payloads as Record<string, { record_digest?: string }>)[0]?.record_digest)
			.toBe("f".repeat(64));
	});

	test("retries a pending payload with an identical import timestamp", async () => {
		const root = await mkdtemp(join(tmpdir(), "pensieve-importer-failure-"));
		await writeFile(join(root, "session.jsonl"), '{"sessionId":"retry-me"}\n');
		const records: Array<Record<string, unknown>> = [];
		const sink: ImportSink = {
			async upload(_path, digest, size) {
				return { digest, size, media_type: "application/x-ndjson", locator: "memory:payload" };
			},
			async postRecord(record) {
				records.push(record);
				if (records.length === 1) throw new Error("temporary failure");
				return { digest: "a".repeat(64) };
			},
		};
		const options: ImportOptions = {
			sink: "https://sink.invalid", token: "secret", identity: "agent:test",
			source: root, dryRun: false, concurrency: 1, statePath: join(root, "state.json"),
		};
		expect((await importTranscripts(options, sink)).failed).toBe(1);
		expect((await importTranscripts(options, sink)).imported).toBe(1);
		expect(records).toHaveLength(2);
		expect(records[0]?.imported_at).toBe(records[1]?.imported_at);
	});
});
