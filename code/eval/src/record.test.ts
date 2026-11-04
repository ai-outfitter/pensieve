import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
	BLOB_THRESHOLD_BYTES,
	blobKey,
	blobRef,
	buildRecord,
	canonicalize,
	recordDigest,
	recordKey,
	sha256Hex,
	splitBody,
	validateRecord,
	verifyRecordBlobs,
	type AgentRecord,
	type AgentRecordInput,
} from "./index.ts";
import { validateRecordFile } from "./node.ts";
import { tempRoot } from "./test-fixture.ts";

const ID = "019a4f6e-8c2b-7d41-9a3e-5b6c7d8e9f01";

/** One model call that ran one tool with a small input and a large output. */
async function input() {
	const request = await splitBody('{"model":"m","messages":[{"role":"user","content":"weather in Lisbon?"}]}');
	const response = await splitBody({ id: "resp_1", content: [{ type: "tool_use", name: "weather" }] });
	const big = await splitBody({ forecast: "sun ".repeat(BLOB_THRESHOLD_BYTES) });
	const record: AgentRecordInput = {
		id: ID,
		recorded_at: "2026-11-04T10:00:02.500Z",
		evidence: "live-provider",
		client: { kind: "outfitter", version: "1.4.0" },
		context: {
			kind: "thread",
			thread_id: "thr_1",
			entry_id: "ent_1",
			workflow_run_id: null,
			workflow_step: null,
			organization_id: "org_1",
			user_id: "usr_1",
		},
		sequence: { turn_key: "sub_1", step: 0 },
		model: { provider: "example", id: "example-model", settings: { temperature: 0, max_tokens: 1024 } },
		request: { body: request.ref, system_digest: await sha256Hex("You are helpful."), tool_names: ["weather"] },
		response: { body: response.ref, text: "", finish_reason: "tool-calls" },
		usage: { input_tokens: 120, output_tokens: 18, cached_input_tokens: 0, reasoning_tokens: null },
		tool_calls: [
			{ call_id: "call_1", name: "weather", input: { city: "Lisbon" }, input_blob: null, output: null, output_blob: big.ref, error: null, status: "ok" },
		],
		timing: { started_at: "2026-11-04T10:00:00Z", ended_at: "2026-11-04T10:00:02Z" },
		status: "complete",
		error: null,
	};
	return { record, blobs: [request, response, big] };
}

const built = async () => (await buildRecord((await input()).record)).record;
const fields = (v: unknown) => validateRecord(v).issues.map((i) => `${i.field ?? ""}: ${i.message}`);

/** Write a record and its blobs the way the bucket lays them out. */
async function stored() {
	const { record, blobs } = await input();
	const out = await buildRecord(record);
	const root = await tempRoot();
	await mkdir(join(root, "blobs"), { recursive: true });
	for (const b of blobs) await writeFile(join(root, blobKey(b.ref.digest)), b.bytes);
	const path = join(root, out.key);
	await mkdir(join(path, ".."), { recursive: true });
	await writeFile(path, out.bytes);
	return { root, path, blobDir: join(root, "blobs"), out, blobs };
}

describe("agent records", () => {
	test("a good record builds, validates, and lands at its key", async () => {
		const { record } = await input();
		const out = await buildRecord(record);
		expect(out.record.standard).toBe("pensieve.agent-record/v0");
		expect(out.key).toBe(`records/2026/11/04/${ID}.json`);
		expect(new TextDecoder().decode(out.bytes)).toBe(canonicalize(out.record));
		expect(out.digest).toBe(await sha256Hex(out.bytes));
		expect(await recordDigest(out.record)).toBe(out.digest);
		expect(await recordDigest(out.bytes)).toBe(out.digest);
		const report = validateRecord(out.bytes);
		expect(report).toEqual({ valid: true, id: ID, issues: [], gaps: [] });
	});

	test("buildRecord lists every cited blob once, sorted by digest", async () => {
		// THIS TEST VALIDATES A HARD REQUIREMENT (EVL-002.3.7)
		// YOU MUST NOT MODIFY THIS TEST UNLESS THE REQUIREMENT CHANGES
		const { record, blobs } = await input();
		record.tool_calls.push({ ...record.tool_calls[0]!, call_id: "call_2" }); // cites the same output blob again
		const out = await buildRecord(record);
		expect(out.record.blobs.map((b) => b.digest)).toEqual(blobs.map((b) => b.ref.digest).sort());
	});

	test("an unknown field fails, at any level except model.settings", async () => {
		// THIS TEST VALIDATES A HARD REQUIREMENT (EVL-002.3.1)
		// YOU MUST NOT MODIFY THIS TEST UNLESS THE REQUIREMENT CHANGES
		const r = await built();
		expect(fields({ ...r, sensitive: true })).toEqual(["sensitive: is not a known field"]);
		expect(fields({ ...r, usage: { ...r.usage, cost: 1 } })).toEqual(["usage.cost: is not a known field"]);
		const tool = structuredClone(r);
		(tool.tool_calls[0] as unknown as Record<string, unknown>).redacted = true;
		expect(fields(tool)).toEqual(["tool_calls[0].redacted: is not a known field"]);
		expect(fields({ ...r, model: { ...r.model, settings: { anything: { goes: 1 } } } })).toEqual([]);
	});

	test("an unknown standard is rejected, not guessed at", async () => {
		// THIS TEST VALIDATES A HARD REQUIREMENT (EVL-002.1.3)
		// YOU MUST NOT MODIFY THIS TEST UNLESS THE REQUIREMENT CHANGES
		const r = await built();
		expect(fields({ ...r, standard: "pensieve.agent-record/v1" })).toEqual([
			'standard: unknown standard "pensieve.agent-record/v1"; expected pensieve.agent-record/v0',
		]);
	});

	test("timestamps are strict and ended_at is not before started_at", async () => {
		// THIS TEST VALIDATES A HARD REQUIREMENT (EVL-002.3.3)
		// YOU MUST NOT MODIFY THIS TEST UNLESS THE REQUIREMENT CHANGES
		const r = await built();
		expect(fields({ ...r, recorded_at: "2026-11-04 10:00:02" })).toEqual([
			"recorded_at: must be an ISO-8601 date-time with an offset, like 2026-10-30T15:00:00Z",
		]);
		expect(fields({ ...r, timing: { ...r.timing, started_at: "2026-11-04T10:00:00" } })).toEqual([
			"timing.started_at: must be an ISO-8601 date-time with an offset, like 2026-10-30T15:00:00Z",
		]);
		expect(fields({ ...r, timing: { started_at: "2026-11-04T10:00:02Z", ended_at: "2026-11-04T10:00:01Z" } })).toEqual([
			"timing.ended_at: is before timing.started_at",
		]);
	});

	test("ids and digests are well-formed", async () => {
		// THIS TEST VALIDATES A HARD REQUIREMENT (EVL-002.3.2)
		// YOU MUST NOT MODIFY THIS TEST UNLESS THE REQUIREMENT CHANGES
		const r = await built();
		expect(fields({ ...r, id: "019a4f6e-8c2b-4d41-9a3e-5b6c7d8e9f01" })).toEqual([`id: must match ${/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/}`]);
		expect(fields({ ...r, request: { ...r.request, system_digest: "ABC" } })).toEqual([`request.system_digest: must match ${/^[0-9a-f]{64}$/}`]);
	});

	test("a cited blob not listed in blobs fails, and so does a listed blob nothing cites", async () => {
		// THIS TEST VALIDATES A HARD REQUIREMENT (EVL-002.3.7)
		// YOU MUST NOT MODIFY THIS TEST UNLESS THE REQUIREMENT CHANGES
		const r = await built();
		const cited = r.request.body!.digest;
		expect(fields({ ...r, blobs: r.blobs.filter((b) => b.digest !== cited) })).toEqual([
			`request.body: cites blob ${cited}, which is not listed in blobs`,
		]);
		const extra = { digest: "f".repeat(64), size: 1, media_type: "text/plain" };
		expect(fields({ ...r, blobs: [...r.blobs, extra] })).toEqual([`blobs: lists blob ${"f".repeat(64)}, which nothing in the record cites`]);
		expect(fields({ ...r, blobs: [...r.blobs].reverse() })).toContainEqual(expect.stringContaining("blobs must be sorted by digest"));
		const wrongSize = structuredClone(r);
		wrongSize.request.body!.size += 1;
		expect(fields(wrongSize)).toEqual([`request.body: does not match the blobs entry for ${cited}`]);
	});

	test("a missing or modified blob fails against a blob store", async () => {
		// THIS TEST VALIDATES A HARD REQUIREMENT (EVL-002.4.1)
		// YOU MUST NOT MODIFY THIS TEST UNLESS THE REQUIREMENT CHANGES
		const { path, blobDir, blobs } = await stored();
		expect((await validateRecordFile(path, { blobs: blobDir })).issues).toEqual([]);

		const [request, response] = blobs as [(typeof blobs)[0], (typeof blobs)[0]];
		await unlink(join(blobDir, request.ref.digest));
		await writeFile(join(blobDir, response.ref.digest), new TextEncoder().encode("tampered"));
		const report = await validateRecordFile(path, { blobs: blobDir });
		expect(report.valid).toBe(false);
		expect(report.issues).toContainEqual({ file: blobKey(request.ref.digest), message: "listed in blobs but missing" });
		expect(report.issues).toContainEqual(expect.objectContaining({ file: blobKey(response.ref.digest), field: "digest" }));
		expect(report.issues).toContainEqual(expect.objectContaining({ file: blobKey(response.ref.digest), field: "size" }));

		// The same check runs on any store, such as an in-memory map or an R2 binding.
		const store = new Map(blobs.map((b) => [b.ref.digest, b.bytes]));
		const record = JSON.parse(await readFile(path, "utf8"));
		expect(await verifyRecordBlobs(record, async (d) => store.get(d) ?? null)).toEqual([]);
		expect(await verifyRecordBlobs(record, async () => { throw new Error("offline"); })).toHaveLength(3);
	});

	test("non-canonical bytes fail even when the value is valid", async () => {
		// THIS TEST VALIDATES A HARD REQUIREMENT (EVL-002.1.2)
		// YOU MUST NOT MODIFY THIS TEST UNLESS THE REQUIREMENT CHANGES
		const r = await built();
		expect(validateRecord(JSON.stringify(r, null, 2)).issues).toEqual([{ file: "record.json", message: "is not canonical JSON" }]);
		expect(validateRecord(new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(canonicalize(r))])).valid).toBe(false);
		expect(validateRecord(canonicalize(r)).valid).toBe(true);
		expect(validateRecord(r).valid).toBe(true); // a parsed value has no bytes to compare
	});

	test("tool calls: inline or blob, never both; status agrees with error and output", async () => {
		// THIS TEST VALIDATES A HARD REQUIREMENT (EVL-002.3.6)
		// YOU MUST NOT MODIFY THIS TEST UNLESS THE REQUIREMENT CHANGES
		const r = await built();
		const call = r.tool_calls[0]!;
		const withCall = (patch: Partial<AgentRecord["tool_calls"][0]>) => ({ ...r, tool_calls: [{ ...call, ...patch }] });
		expect(fields(withCall({ output: { also: "inline" } }))).toEqual(["tool_calls[0].output: must be null when output_blob is set"]);
		expect(fields(withCall({ status: "error" }))).toEqual(["tool_calls[0].error: is required when status is error"]);
		expect(fields(withCall({ error: "boom" }))).toEqual(["tool_calls[0].error: must be null when status is ok"]);
		expect(fields({ ...r, tool_calls: [call, call] })).toEqual(["tool_calls[1].call_id: duplicate call id call_1"]);
		const omitted = validateRecord({ ...r, blobs: r.blobs.filter((b) => b.digest !== call.output_blob!.digest), tool_calls: [{ ...call, output_blob: null, status: "omitted" }] });
		expect(omitted).toMatchObject({ valid: true, gaps: [{ field: "tool_calls[0].output", reason: "the tool output was not captured" }] });
	});

	test("record status agrees with error and finish_reason; context names its owner", async () => {
		// THIS TEST VALIDATES A HARD REQUIREMENT (EVL-002.3.4)
		// YOU MUST NOT MODIFY THIS TEST UNLESS THE REQUIREMENT CHANGES
		const r = await built();
		expect(fields({ ...r, error: "rate limited" })).toEqual(["error: must be null when status is complete"]);
		expect(fields({ ...r, status: "error" })).toEqual(["error: is required when status is error"]);
		expect(fields({ ...r, response: { ...r.response, finish_reason: null } })).toEqual(["response.finish_reason: is required when status is complete"]);
		expect(fields({ ...r, status: "aborted", response: { ...r.response, finish_reason: null } })).toEqual([]);
		expect(fields({ ...r, context: { ...r.context, thread_id: null } })).toEqual(["context.thread_id: is required when context.kind is thread"]);
		expect(fields({ ...r, context: { ...r.context, kind: "workflow-step" } })).toEqual([
			"context.workflow_run_id: is required when context.kind is workflow-step",
			"context.workflow_step: is required when context.kind is workflow-step",
		]);
	});

	test("an uncaptured request body is a reported gap, not a failure", async () => {
		// THIS TEST VALIDATES A HARD REQUIREMENT (EVL-002.4.2)
		// YOU MUST NOT MODIFY THIS TEST UNLESS THE REQUIREMENT CHANGES
		const { record } = await input();
		const out = await buildRecord({ ...record, request: { ...record.request, body: null } });
		const report = validateRecord(out.bytes);
		expect(report.valid).toBe(true);
		expect(report.gaps).toEqual([{ field: "request.body", reason: "the exact provider request body was not captured" }]);
	});

	test("the validator never throws on malformed input", () => {
		// THIS TEST VALIDATES A HARD REQUIREMENT (EVL-002.5.3)
		// YOU MUST NOT MODIFY THIS TEST UNLESS THE REQUIREMENT CHANGES
		let deep: unknown = 1;
		for (let i = 0; i < 40; i++) deep = [deep];
		const inputs: unknown[] = [undefined, null, 42, [], () => 1, { standard: "pensieve.agent-record/v0" }, deep, new Uint8Array([0xff, 0xfe]), "not json", new Uint8Array(9 * 1024 * 1024)];
		for (const v of inputs) {
			const report = validateRecord(v);
			expect(report.valid).toBe(false);
			expect(report.issues.length).toBeGreaterThan(0);
		}
	});

	test("buildRecord refuses an invalid record", async () => {
		// THIS TEST VALIDATES A HARD REQUIREMENT (EVL-002.2.5)
		// YOU MUST NOT MODIFY THIS TEST UNLESS THE REQUIREMENT CHANGES
		const { record } = await input();
		await expect(buildRecord({ ...record, status: "error" })).rejects.toThrow("error: is required when status is error");
	});

	test("splitBody keeps strings and bytes exact and canonicalizes values", async () => {
		const exact = '{"b":1, "a":2}';
		const s = await splitBody(exact);
		expect(new TextDecoder().decode(s.bytes)).toBe(exact);
		expect(s.ref).toEqual({ digest: await sha256Hex(exact), size: 14, media_type: "application/json" });
		const v = await splitBody({ b: 1, a: 2 });
		expect(new TextDecoder().decode(v.bytes)).toBe('{"a":2,"b":1}');
		const bytes = new Uint8Array([1, 2, 3]);
		expect((await splitBody(bytes, "application/octet-stream")).bytes).toBe(bytes);
		expect(await blobRef(bytes)).toEqual({ digest: await sha256Hex(bytes), size: 3, media_type: "application/octet-stream" });
		expect(recordKey({ id: ID, recorded_at: "2026-11-04T23:30:00-02:00" })).toBe(`records/2026/11/05/${ID}.json`);
	});

	test("a record file is named by its id and dated by recorded_at", async () => {
		// THIS TEST VALIDATES A HARD REQUIREMENT (EVL-002.2.1)
		// YOU MUST NOT MODIFY THIS TEST UNLESS THE REQUIREMENT CHANGES
		const { root, out } = await stored();
		const misdated = join(root, "records/2026/11/03", `${ID}.json`);
		await mkdir(join(misdated, ".."), { recursive: true });
		await writeFile(misdated, out.bytes);
		expect((await validateRecordFile(misdated)).issues).toEqual([
			{ file: `${ID}.json`, message: `is at records/2026/11/03/${ID}.json but its key is records/2026/11/04/${ID}.json` },
		]);
		const renamed = join(root, "copy.json");
		await writeFile(renamed, out.bytes);
		expect((await validateRecordFile(renamed)).issues).toEqual([{ file: "copy.json", message: `must be named ${ID}.json` }]);
	});
});

describe("agent records: portability", () => {
	test("the record module imports no runtime-specific APIs", async () => {
		// THIS TEST VALIDATES A HARD REQUIREMENT (EVL-002.5.2)
		// YOU MUST NOT MODIFY THIS TEST UNLESS THE REQUIREMENT CHANGES
		const source = await readFile(join(import.meta.dir, "record.ts"), "utf8");
		expect(source).not.toMatch(/from\s+["'](?:bun|bun:|node:)/);
		expect(source).not.toMatch(/\bBun\.|\bprocess\.|\bBuffer\b|\brequire\(/);
	});

	const node = spawnSync("node", ["--version"], { encoding: "utf8" });
	const [major = 0, minor = 0] = (node.stdout ?? "").replace("v", "").split(".").map(Number);
	const nodeStrips = node.status === 0 && (major > 22 || (major === 22 && minor >= 18));

	test.skipIf(!nodeStrips)("Node builds byte-identical records", async () => {
		// THIS TEST VALIDATES A HARD REQUIREMENT (EVL-002.5.2)
		// YOU MUST NOT MODIFY THIS TEST UNLESS THE REQUIREMENT CHANGES
		const { record } = await input();
		const script = `
			const e = await import(${JSON.stringify(join(import.meta.dir, "index.ts"))});
			const out = await e.buildRecord(${JSON.stringify(record)});
			console.log(JSON.stringify({ digest: out.digest, valid: e.validateRecord(out.bytes).valid }));
		`;
		const run = spawnSync("node", ["--no-warnings", "--input-type=module", "-e", script], { encoding: "utf8", timeout: 60_000 });
		expect(run.stderr).toBe("");
		expect(JSON.parse(run.stdout)).toEqual({ digest: (await buildRecord(record)).digest, valid: true });
	}, 60_000);
});

describe("agent records: cli", () => {
	const cli = (...args: string[]) => spawnSync("bun", [join(import.meta.dir, "cli.ts"), ...args], { encoding: "utf8" });

	test("exit codes: valid 0, invalid 1, usage 2", async () => {
		const { path, blobDir, blobs } = await stored();
		const ok = cli("record", "validate", path, "--blobs", blobDir);
		expect(ok.stdout).toContain(`valid   ${path} (${ID})`);
		expect(ok.status).toBe(0);
		await unlink(join(blobDir, blobs[0]!.ref.digest));
		const missing = cli("record", "validate", path, `--blobs=${blobDir}`, "--json");
		expect(missing.status).toBe(1);
		expect(JSON.parse(missing.stdout)[0].issues).toEqual([{ file: blobKey(blobs[0]!.ref.digest), message: "listed in blobs but missing" }]);
		expect(cli("record", "validate", path).status).toBe(0); // without --blobs, only the record is checked
		expect(cli("record", "validate").status).toBe(2);
		expect(cli("record", "validate", path, "--blobs").status).toBe(2);
		expect(cli("record", "validate", path, "--publication").status).toBe(2);
		expect(cli("record", "check", path).status).toBe(2);
	});
});
