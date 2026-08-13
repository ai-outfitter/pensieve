import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { FatalImportError, HttpImportSink, importTranscripts, type ImportOptions, type ImportSink } from "./importer.ts";
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
		// THIS TEST VALIDATES A HARD REQUIREMENT (SRV-001.5.5)
		// YOU MUST NOT MODIFY THIS TEST UNLESS THE REQUIREMENT CHANGES
		// The digest must be of the original bytes. A shape check passes for any
		// hash of any content, including one taken after re-serializing the lines.
		const bytes = await readFile(join(fixtures, "metadata-across-lines.jsonl"));
		expect(result.digest).toBe(new Bun.CryptoHasher("sha256").update(bytes).digest("hex"));
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
			source: join(root, "projects"), dryRun: false, statePath,
			now: () => new Date("2026-08-11T12:00:00.000Z"),
		};

		const first = await importTranscripts(options, sink);
		expect(first.imported).toBe(1);
		expect(calls.uploads).toBe(1);
		expect(calls.records).toHaveLength(1);
		// THIS TEST VALIDATES A HARD REQUIREMENT (RTR-001.3.3)
		// YOU MUST NOT MODIFY THIS TEST UNLESS THE REQUIREMENT CHANGES
		expect(calls.records[0]).toMatchObject({
			identity: "agent:test-workstation", provenance: "imported", observed: false,
			policy_digest: "unattested:imported",
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
			source: root, dryRun: false, statePath: join(root, "state.json"),
		};
		expect((await importTranscripts(options, sink)).failed).toBe(1);
		expect((await importTranscripts(options, sink)).imported).toBe(1);
		expect(records).toHaveLength(2);
		expect(records[0]?.imported_at).toBe(records[1]?.imported_at);
	});
});

describe("safety before the sink", () => {
	test("a dry run contacts nothing and writes no checkpoint", async () => {
		const root = await mkdtemp(join(tmpdir(), "pensieve-importer-dry-"));
		await Bun.write(join(root, "session.jsonl"), await readFile(join(fixtures, "metadata-across-lines.jsonl")));
		const statePath = join(root, "state", "imports.json");
		const calls = { uploads: 0, records: 0 };
		const sink: ImportSink = {
			async upload(_path, digest, size) {
				calls.uploads += 1;
				return { digest, size, media_type: "application/x-ndjson", locator: "memory:payload" };
			},
			async postRecord() {
				calls.records += 1;
				return { digest: "f".repeat(64) };
			},
		};

		const summary = await importTranscripts(
			{
				sink: "https://sink.invalid", token: "secret", identity: "agent:test",
				source: root, dryRun: true, statePath,
			},
			sink,
		);

		expect(summary.wouldImport).toBe(1);
		expect(summary.imported).toBe(0);
		expect(calls).toEqual({ uploads: 0, records: 0 });
		expect(await Bun.file(statePath).exists()).toBe(false);
	});

	test("an unreadable transcript fails that file and not the run", async () => {
		const root = await mkdtemp(join(tmpdir(), "pensieve-importer-unreadable-"));
		await Bun.write(join(root, "good.jsonl"), '{"sessionId":"keeps-going"}\n');
		const denied = join(root, "denied.jsonl");
		await writeFile(denied, '{"sessionId":"unreadable"}\n');
		await chmod(denied, 0o000);

		const sink: ImportSink = {
			async upload(_path, digest, size) {
				return { digest, size, media_type: "application/x-ndjson", locator: "memory:payload" };
			},
			async postRecord() {
				return { digest: "b".repeat(64) };
			},
		};
		const summary = await importTranscripts(
			{
				sink: "https://sink.invalid", token: "secret", identity: "agent:test",
				source: root, dryRun: false, statePath: join(root, "state.json"),
			},
			sink,
		);

		await chmod(denied, 0o600);
		expect(summary.discovered).toBe(2);
		expect(summary.imported).toBe(1);
		expect(summary.failed).toBe(1);
		expect(summary.decisions.find((d) => d.path === denied)?.reason).toMatch(/cannot read transcript/);
	});

	test("a refused credential aborts before the rest of the tree is uploaded", async () => {
		const root = await mkdtemp(join(tmpdir(), "pensieve-importer-forbidden-"));
		for (const name of ["a", "b", "c", "d", "e", "f"]) {
			await Bun.write(join(root, `${name}.jsonl`), `{"sessionId":"${name}"}\n`);
		}
		let uploads = 0;
		const sink: ImportSink = {
			async upload(_path, digest, size) {
				uploads += 1;
				return { digest, size, media_type: "application/x-ndjson", locator: "memory:payload" };
			},
			async postRecord() {
				throw new FatalImportError("record refused: 403 principal may not write evidence");
			},
		};

		// The payload upload only needs write permission; the identity check runs
		// at record ingest. Without the abort, every transcript in the tree lands
		// in COMPLIANCE-locked storage with no record referencing it.
		await expect(
			importTranscripts(
				{
					sink: "https://sink.invalid", token: "secret", identity: "agent:wrong",
					source: root, dryRun: false, statePath: join(root, "state.json"),
				},
				sink,
			),
		).rejects.toThrow(FatalImportError);
		expect(uploads).toBeLessThan(6);
	});

	test("a transcript that grew is not written twice without naming what it supersedes", async () => {
		const root = await mkdtemp(join(tmpdir(), "pensieve-importer-grew-"));
		const transcript = join(root, "live.jsonl");
		await writeFile(transcript, '{"sessionId":"still-running"}\n');
		const statePath = join(root, "state.json");
		const records: Array<Record<string, unknown>> = [];
		let nextRecordDigest = "1".repeat(64);
		const sink: ImportSink = {
			async upload(_path, digest, size) {
				return { digest, size, media_type: "application/x-ndjson", locator: "memory:payload" };
			},
			async postRecord(record) {
				records.push(record);
				return { digest: nextRecordDigest };
			},
		};
		const options: ImportOptions = {
			sink: "https://sink.invalid", token: "secret", identity: "agent:test",
			source: root, dryRun: false, statePath,
		};

		expect((await importTranscripts(options, sink)).imported).toBe(1);

		// The session keeps writing. Its digest changes, so the digest-keyed skip
		// does not fire — but a second unlinked record for the same run cannot be
		// withdrawn from a write-once store. SRV-001.3.5.
		await writeFile(transcript, '{"sessionId":"still-running"}\n{"type":"more"}\n');
		nextRecordDigest = "2".repeat(64);
		const second = await importTranscripts(options, sink);
		expect(second.imported).toBe(1);
		expect(records).toHaveLength(2);
		expect(records[1]).toMatchObject({ supersedes: ["1".repeat(64)] });

		// With no retained prior record digest there is nothing to supersede, so
		// the only honest action is to leave the store alone.
		const orphaned = JSON.parse(await readFile(statePath, "utf8"));
		for (const entry of Object.values(orphaned.payloads as Record<string, { record_digest?: string }>)) {
			delete entry.record_digest;
		}
		await writeFile(statePath, JSON.stringify(orphaned));
		await writeFile(transcript, '{"sessionId":"still-running"}\n{"type":"more"}\n{"type":"yet more"}\n');
		const third = await importTranscripts(options, sink);
		expect(third.imported).toBe(0);
		expect(third.decisions[0]?.reason).toMatch(/prior record digest is unknown/);
	});
});

describe("the sink client refuses what it cannot prove", () => {
	const originalFetch = globalThis.fetch;
	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	function respondWith(body: unknown, status = 201): void {
		globalThis.fetch = (async () =>
			new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
	}

	// THIS TEST VALIDATES A HARD REQUIREMENT (SRV-001.5.5)
	// YOU MUST NOT MODIFY THIS TEST UNLESS THE REQUIREMENT CHANGES
	test("a payload digest the sink disagrees with fails the file", async () => {
		const root = await mkdtemp(join(tmpdir(), "pensieve-importer-echo-"));
		const path = join(root, "session.jsonl");
		await writeFile(path, '{"sessionId":"echo"}\n');
		respondWith({ digest: "9".repeat(64), locator: "s3://bucket/payloads/9" });

		// The object is retention-locked on write, so a record bound to bytes the
		// store hashed differently could never be corrected.
		await expect(new HttpImportSink("https://sink.invalid", "t").upload(path, "0".repeat(64), 21)).rejects.toThrow(
			/sink returned payload digest/,
		);
	});

	test("a payload response with no locator fails the file", async () => {
		const root = await mkdtemp(join(tmpdir(), "pensieve-importer-locator-"));
		const path = join(root, "session.jsonl");
		await writeFile(path, '{"sessionId":"no-locator"}\n');
		respondWith({ digest: "0".repeat(64) });

		await expect(new HttpImportSink("https://sink.invalid", "t").upload(path, "0".repeat(64), 26)).rejects.toThrow(
			/no payload locator/,
		);
	});

	test("a record accepted without a digest is an error, not a success", async () => {
		respondWith({});

		// GET /v0/records is keyed on the record digest and nothing else. Reporting
		// success here is what left 2001 imported records unaddressable.
		await expect(new HttpImportSink("https://sink.invalid", "t").postRecord({ kind: "transcript" })).rejects.toThrow(
			/returned no record digest/,
		);
	});

	test("a refused credential is fatal rather than one more failed file", async () => {
		respondWith({ title: "principal may not write evidence" }, 403);

		await expect(new HttpImportSink("https://sink.invalid", "t").postRecord({ kind: "transcript" })).rejects.toThrow(
			FatalImportError,
		);
	});
});
