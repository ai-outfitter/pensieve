/**
 * Agent records (EVL-002, `pensieve.agent-record/v0`): one model call and the
 * tool calls it made, written once as canonical JSON, with large bodies in
 * content-addressed blobs.
 *
 * Pure: no runtime imports, hashing through Web Crypto, so it runs unchanged
 * under Node, Bun, and Cloudflare Workers. Reading a blob directory is in
 * `./node.ts`; any other blob store plugs into `verifyRecordBlobs`.
 */
import { canonicalize, sha256Hex } from "./canonical.ts";
import type { Issue } from "./types.ts";
import { Checker, HEX64, isObj, jsonProblem, parseJson, sameBytes, type Obj } from "./validate.ts";

/** The record standard this package reads and writes. EVL-002.1.3. */
export const RECORD_STANDARD = "pensieve.agent-record/v0";

export const RECORD_EVIDENCE = ["recorded", "real-model", "live-provider"] as const;
export const CLIENT_KINDS = ["outfitter", "claude-code", "codex", "pi", "otel"] as const;
export const CONTEXT_KINDS = ["thread", "workflow-step"] as const;
export const RECORD_STATUSES = ["complete", "error", "aborted"] as const;
export const TOOL_CALL_STATUSES = ["ok", "error", "omitted"] as const;

/** A tool input or output whose canonical JSON is larger than this goes to a blob. EVL-002.2.4. */
export const BLOB_THRESHOLD_BYTES = 4096;
/** Bound on a record file, so validation stays bounded on hostile input. EVL-002.5.3. */
export const MAX_RECORD_BYTES = 8 * 1024 * 1024;

export type RecordEvidence = (typeof RECORD_EVIDENCE)[number];
export type ClientKind = (typeof CLIENT_KINDS)[number];
export type ContextKind = (typeof CONTEXT_KINDS)[number];
export type RecordStatus = (typeof RECORD_STATUSES)[number];
export type ToolCallStatus = (typeof TOOL_CALL_STATUSES)[number];

/** A content-addressed body: `blobs/<digest>` holds exactly `size` bytes whose SHA-256 is `digest`. */
export interface BlobRef {
	digest: string;
	size: number;
	media_type: string;
}

export interface ToolCall {
	call_id: string;
	name: string;
	/** Inline JSON input, or null when `input_blob` holds it. */
	input: unknown;
	input_blob: BlobRef | null;
	/** Inline JSON output, or null when `output_blob` holds it or there is none. */
	output: unknown;
	output_blob: BlobRef | null;
	error: string | null;
	status: ToolCallStatus;
}

export interface Usage {
	input_tokens: number | null;
	output_tokens: number | null;
	cached_input_tokens: number | null;
	reasoning_tokens: number | null;
}

export interface AgentRecord {
	standard: typeof RECORD_STANDARD;
	/** UUID v7, lowercase. */
	id: string;
	recorded_at: string;
	evidence: RecordEvidence;
	client: { kind: ClientKind; version: string | null };
	context: {
		kind: ContextKind;
		thread_id: string | null;
		entry_id: string | null;
		workflow_run_id: string | null;
		workflow_step: string | null;
		organization_id: string | null;
		user_id: string | null;
	};
	/** `step` is the index of this model call within the turn's tool loop, from 0. */
	sequence: { turn_key: string; step: number };
	model: { provider: string; id: string; settings: Record<string, unknown> };
	request: { body: BlobRef | null; system_digest: string | null; tool_names: string[] };
	response: { body: BlobRef | null; text: string | null; finish_reason: string | null };
	usage: Usage;
	tool_calls: ToolCall[];
	timing: { started_at: string; ended_at: string };
	status: RecordStatus;
	error: string | null;
	/** Every blob the record cites, once each, sorted by digest. Filled by `buildRecord`. */
	blobs: BlobRef[];
}

/** A record as a writer supplies it: the standard and the blob list are filled in. */
export type AgentRecordInput = Omit<AgentRecord, "standard" | "blobs">;

/** A cited body that was not captured. Gaps do not make a record invalid; they are reported. EVL-002.4. */
export interface RecordGap {
	field: string;
	reason: string;
}

export interface RecordReport {
	valid: boolean;
	id: string | null;
	issues: Issue[];
	gaps: RecordGap[];
}

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MEDIA_TYPE = /^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]*(?:\s*;.*)?$/;

const KEYS = {
	record: ["standard", "id", "recorded_at", "evidence", "client", "context", "sequence", "model", "request", "response", "usage", "tool_calls", "timing", "status", "error", "blobs"],
	client: ["kind", "version"],
	context: ["kind", "thread_id", "entry_id", "workflow_run_id", "workflow_step", "organization_id", "user_id"],
	sequence: ["turn_key", "step"],
	model: ["provider", "id", "settings"],
	request: ["body", "system_digest", "tool_names"],
	response: ["body", "text", "finish_reason"],
	usage: ["input_tokens", "output_tokens", "cached_input_tokens", "reasoning_tokens"],
	tool: ["call_id", "name", "input", "input_blob", "output", "output_blob", "error", "status"],
	timing: ["started_at", "ended_at"],
	blob: ["digest", "size", "media_type"],
} as const;

const ENCODER = new TextEncoder();

/** The object key of a blob. EVL-002.2.2. */
export function blobKey(digest: string): string {
	return `blobs/${digest}`;
}

/** The object key of a record: `records/<yyyy>/<mm>/<dd>/<id>.json`, by the UTC date of `recorded_at`. EVL-002.2.1. */
export function recordKey(record: { id: string; recorded_at: string }): string {
	const day = new Date(Date.parse(record.recorded_at)).toISOString().slice(0, 10).split("-");
	return `records/${day.join("/")}/${record.id}.json`;
}

/** The blob reference for exact bytes. */
export async function blobRef(bytes: Uint8Array, mediaType = "application/octet-stream"): Promise<BlobRef> {
	return { digest: await sha256Hex(bytes), size: bytes.byteLength, media_type: mediaType };
}

/**
 * Turn a body into blob bytes and their reference, for the writer to store at
 * `blobKey(ref.digest)` and cite. Bytes and strings are kept exactly as given
 * (an exact provider request body is a string); any other value is encoded as
 * canonical JSON. EVL-002.2.3.
 */
export async function splitBody(body: unknown, mediaType = "application/json"): Promise<{ ref: BlobRef; bytes: Uint8Array }> {
	const bytes = body instanceof Uint8Array ? body : ENCODER.encode(typeof body === "string" ? body : canonicalize(body));
	return { ref: await blobRef(bytes, mediaType), bytes };
}

/** SHA-256 of a record's canonical bytes: what the index and evals cite. Bytes are hashed as given. EVL-002.1.5. */
export function recordDigest(record: AgentRecord | Uint8Array): Promise<string> {
	return sha256Hex(record instanceof Uint8Array ? record : canonicalize(record));
}

/** Every blob reference the record cites outside `blobs`, with the field that cites it. */
function cited(r: Obj): { field: string; ref: unknown }[] {
	const out: { field: string; ref: unknown }[] = [];
	if (isObj(r.request) && r.request.body !== null && r.request.body !== undefined) out.push({ field: "request.body", ref: r.request.body });
	if (isObj(r.response) && r.response.body !== null && r.response.body !== undefined) out.push({ field: "response.body", ref: r.response.body });
	if (Array.isArray(r.tool_calls)) {
		r.tool_calls.forEach((t, i) => {
			if (!isObj(t)) return;
			for (const key of ["input_blob", "output_blob"] as const) {
				if (t[key] !== null && t[key] !== undefined) out.push({ field: `tool_calls[${i}].${key}`, ref: t[key] });
			}
		});
	}
	return out;
}

/** Every key a record object defines must be present: `Checker.obj` only rejects unknown ones. */
function missing(c: Checker, v: Obj, field: string, keys: readonly string[]): void {
	for (const key of keys) if (!Object.hasOwn(v, key)) c.fail(field ? `${field}.${key}` : key, "is missing");
}

/** An object with exactly these keys: none unknown, none missing. EVL-002.3.1. */
function exact(c: Checker, v: unknown, field: string, keys: readonly string[]): v is Obj {
	if (!c.obj(v, field, keys)) return false;
	missing(c, v, field, keys);
	return true;
}

function checkRef(c: Checker, v: unknown, field: string): v is BlobRef {
	if (!exact(c, v, field, KEYS.blob)) return false;
	const ok = [c.str(v.digest, `${field}.digest`, HEX64), c.int(v.size, `${field}.size`), c.str(v.media_type, `${field}.media_type`, MEDIA_TYPE)];
	return ok.every(Boolean);
}

function refOrNull(c: Checker, v: unknown, field: string): void {
	if (v !== null) checkRef(c, v, field);
}

function textOrNull(c: Checker, v: unknown, field: string): void {
	if (v !== null && typeof v !== "string") c.fail(field, "must be a string or null");
}

/** Schema and internal consistency of a parsed record value. EVL-002.3. */
function checkRecord(value: unknown, file: string): { issues: Issue[]; gaps: RecordGap[] } {
	const c = new Checker(file);
	const gaps: RecordGap[] = [];
	const problem = jsonProblem(value);
	if (problem) return { issues: [{ file, message: problem }], gaps };
	if (!exact(c, value, "", KEYS.record)) return { issues: c.issues, gaps };
	const r = value;

	// EVL-002.1.3: never guess at an unknown standard.
	if (r.standard !== RECORD_STANDARD) {
		c.fail("standard", `unknown standard ${JSON.stringify(r.standard)}; expected ${RECORD_STANDARD}`);
		return { issues: c.issues, gaps };
	}

	c.str(r.id, "id", UUID_V7);
	c.time(r.recorded_at, "recorded_at");
	c.oneOf(r.evidence, "evidence", RECORD_EVIDENCE);

	if (exact(c, r.client, "client", KEYS.client)) {
		c.oneOf(r.client.kind, "client.kind", CLIENT_KINDS);
		c.strOrNull(r.client.version, "client.version");
	}

	if (exact(c, r.context, "context", KEYS.context)) {
		const x = r.context;
		c.oneOf(x.kind, "context.kind", CONTEXT_KINDS);
		for (const key of KEYS.context.slice(1)) c.strOrNull(x[key], `context.${key}`);
		// EVL-002.3.5: a record names what it belongs to.
		if (x.kind === "thread" && x.thread_id === null) c.fail("context.thread_id", "is required when context.kind is thread");
		if (x.kind === "workflow-step") {
			if (x.workflow_run_id === null) c.fail("context.workflow_run_id", "is required when context.kind is workflow-step");
			if (x.workflow_step === null) c.fail("context.workflow_step", "is required when context.kind is workflow-step");
		}
	}

	if (exact(c, r.sequence, "sequence", KEYS.sequence)) {
		c.str(r.sequence.turn_key, "sequence.turn_key");
		c.int(r.sequence.step, "sequence.step");
	}

	if (exact(c, r.model, "model", KEYS.model)) {
		c.str(r.model.provider, "model.provider");
		c.str(r.model.id, "model.id");
		if (!isObj(r.model.settings)) c.fail("model.settings", "must be an object");
	}

	if (exact(c, r.request, "request", KEYS.request)) {
		refOrNull(c, r.request.body, "request.body");
		c.strOrNull(r.request.system_digest, "request.system_digest", HEX64);
		if (c.strings(r.request.tool_names, "request.tool_names")) {
			const seen = new Set<string>();
			for (const name of r.request.tool_names) {
				if (seen.has(name)) c.fail("request.tool_names", `duplicate tool ${name}`);
				seen.add(name);
			}
		}
		if (r.request.body === null) gaps.push({ field: "request.body", reason: "the exact provider request body was not captured" });
	}

	if (exact(c, r.response, "response", KEYS.response)) {
		refOrNull(c, r.response.body, "response.body");
		textOrNull(c, r.response.text, "response.text");
		c.strOrNull(r.response.finish_reason, "response.finish_reason");
		if (r.status === "complete" && r.response.finish_reason === null) c.fail("response.finish_reason", "is required when status is complete");
		if (r.response.body === null && r.status === "complete") gaps.push({ field: "response.body", reason: "the provider response body was not captured" });
	}

	if (exact(c, r.usage, "usage", KEYS.usage)) {
		for (const key of KEYS.usage) if (r.usage[key] !== null) c.int(r.usage[key], `usage.${key}`);
	}

	const callIds = new Set<string>();
	c.list(r.tool_calls, "tool_calls", KEYS.tool, (t, f) => {
		missing(c, t, f, KEYS.tool);
		if (c.str(t.call_id, `${f}.call_id`)) {
			if (callIds.has(t.call_id)) c.fail(`${f}.call_id`, `duplicate call id ${t.call_id}`);
			callIds.add(t.call_id);
		}
		c.str(t.name, `${f}.name`);
		const status = c.oneOf(t.status, `${f}.status`, TOOL_CALL_STATUSES) ? t.status : null;
		refOrNull(c, t.input_blob, `${f}.input_blob`);
		refOrNull(c, t.output_blob, `${f}.output_blob`);
		// EVL-002.3.6: a body is inline or in a blob, never both.
		if (t.input_blob !== null && t.input !== null) c.fail(`${f}.input`, "must be null when input_blob is set");
		if (t.output_blob !== null && t.output !== null) c.fail(`${f}.output`, "must be null when output_blob is set");
		textOrNull(c, t.error, `${f}.error`);
		if (status === "ok" && t.error !== null) c.fail(`${f}.error`, "must be null when status is ok");
		if (status === "error" && (typeof t.error !== "string" || t.error.length === 0)) c.fail(`${f}.error`, "is required when status is error");
		if (status === "omitted") {
			if (t.output !== null || t.output_blob !== null) c.fail(`${f}.status`, "is omitted but an output is recorded");
			gaps.push({ field: `${f}.output`, reason: "the tool output was not captured" });
		}
	});

	if (exact(c, r.timing, "timing", KEYS.timing)) {
		const started = c.time(r.timing.started_at, "timing.started_at");
		const ended = c.time(r.timing.ended_at, "timing.ended_at");
		if (started && ended && Date.parse(r.timing.ended_at as string) < Date.parse(r.timing.started_at as string)) {
			c.fail("timing.ended_at", "is before timing.started_at");
		}
	}

	const status = c.oneOf(r.status, "status", RECORD_STATUSES) ? r.status : null;
	textOrNull(c, r.error, "error");
	if (status === "complete" && r.error !== null) c.fail("error", "must be null when status is complete");
	if (status === "error" && (typeof r.error !== "string" || r.error.length === 0)) c.fail("error", "is required when status is error");

	// EVL-002.3.7: `blobs` lists exactly the cited blobs, once each, sorted by digest.
	const listed = new Map<string, Obj>();
	let previous = "";
	c.list(r.blobs, "blobs", KEYS.blob, (b, f) => {
		if (!checkRef(c, b, f)) return;
		if (listed.has(b.digest)) c.fail(`${f}.digest`, `duplicate blob ${b.digest}`);
		else if (b.digest < previous) c.fail(`${f}.digest`, "blobs must be sorted by digest");
		previous = b.digest;
		listed.set(b.digest, b);
	});
	if (Array.isArray(r.blobs)) {
		const used = new Set<string>();
		for (const { field, ref } of cited(r)) {
			if (!isObj(ref) || typeof ref.digest !== "string") continue;
			used.add(ref.digest);
			const entry = listed.get(ref.digest);
			if (!entry) c.fail(field, `cites blob ${ref.digest}, which is not listed in blobs`);
			else if (entry.size !== ref.size || entry.media_type !== ref.media_type) c.fail(field, `does not match the blobs entry for ${ref.digest}`);
		}
		for (const digest of listed.keys()) if (!used.has(digest)) c.fail("blobs", `lists blob ${digest}, which nothing in the record cites`);
	}

	return { issues: c.issues, gaps };
}

/**
 * Validate a record (EVL-002.1, 3, 4). Given bytes (or the file's text), it
 * also checks the bytes are exactly the canonical form; given a parsed value,
 * only the value. Never throws: any input, however malformed, yields issues.
 * It does not read blobs; see `verifyRecordBlobs`.
 */
export function validateRecord(input: Uint8Array | string | unknown, options: { file?: string } = {}): RecordReport {
	const file = options.file ?? "record.json";
	const issues: Issue[] = [];
	let value: unknown = input;
	const raw = input instanceof Uint8Array ? input : typeof input === "string" ? ENCODER.encode(input) : null;
	if (raw) {
		if (raw.byteLength > MAX_RECORD_BYTES) return { valid: false, id: null, issues: [{ file, message: `is larger than ${MAX_RECORD_BYTES} bytes` }], gaps: [] };
		const parsed = parseJson(raw);
		if ("error" in parsed) return { valid: false, id: null, issues: [{ file, message: parsed.error }], gaps: [] };
		value = parsed.value;
	}
	const checked = checkRecord(value, file);
	issues.push(...checked.issues);
	// EVL-002.1.2: the file is exactly canonicalize(record). Past checkRecord's
	// bounds check the value is plain JSON, so canonicalize cannot throw.
	if (raw && isObj(value) && value.standard === RECORD_STANDARD && !jsonProblem(value)) {
		if (!sameBytes(raw, ENCODER.encode(canonicalize(value)))) issues.push({ file, message: "is not canonical JSON" });
	}
	const id = isObj(value) && typeof value.id === "string" ? value.id : null;
	return { valid: issues.length === 0, id, issues, gaps: checked.gaps };
}

/**
 * Check every blob a record lists against a blob store (EVL-002.4.1): present,
 * with the listed size and SHA-256. `getBlob` returns the bytes or null when
 * absent; a directory, R2, or S3 all fit. Never throws.
 */
export async function verifyRecordBlobs(record: unknown, getBlob: (digest: string) => Promise<Uint8Array | null>): Promise<Issue[]> {
	const issues: Issue[] = [];
	if (!isObj(record) || !Array.isArray(record.blobs)) return issues;
	for (const b of record.blobs) {
		if (!isObj(b) || typeof b.digest !== "string" || !HEX64.test(b.digest)) continue;
		const file = blobKey(b.digest);
		let bytes: Uint8Array | null;
		try {
			bytes = await getBlob(b.digest);
		} catch (error) {
			issues.push({ file, message: `could not be read: ${error instanceof Error ? error.message : String(error)}` });
			continue;
		}
		if (!bytes) {
			issues.push({ file, message: "listed in blobs but missing" });
			continue;
		}
		if (bytes.byteLength !== b.size) issues.push({ file, field: "size", message: `is ${bytes.byteLength} bytes, record says ${b.size}` });
		if ((await sha256Hex(bytes)) !== b.digest) issues.push({ file, field: "digest", message: "content does not match its digest" });
	}
	return issues;
}

/** What `buildRecord` returns: the record, its exact bytes, their digest, and the object key. */
export interface BuiltRecord {
	record: AgentRecord;
	bytes: Uint8Array;
	digest: string;
	key: string;
}

/**
 * Assemble a record for writing: set the standard, drop `undefined` members,
 * fill `blobs` from the cited references, validate, and return the canonical
 * bytes with their digest and object key. Throws on an invalid record, so a
 * writer can never store one. The writer stores the blobs first (EVL-002.2.5).
 */
export async function buildRecord(input: AgentRecordInput): Promise<BuiltRecord> {
	const draft = JSON.parse(canonicalize({ ...input, standard: RECORD_STANDARD, blobs: [] })) as AgentRecord;
	const refs = new Map<string, BlobRef>();
	for (const { ref } of cited(draft as unknown as Obj)) {
		if (isObj(ref) && typeof ref.digest === "string" && !refs.has(ref.digest)) refs.set(ref.digest, ref as unknown as BlobRef);
	}
	draft.blobs = [...refs.values()]
		.sort((a, b) => (a.digest < b.digest ? -1 : a.digest > b.digest ? 1 : 0))
		.map((b) => ({ digest: b.digest, size: b.size, media_type: b.media_type }));
	const text = canonicalize(draft);
	const report = validateRecord(text);
	if (!report.valid) throw new Error(`invalid agent record:\n${report.issues.map((i) => `  ${i.field ?? ""}: ${i.message}`).join("\n")}`);
	const bytes = ENCODER.encode(text);
	return { record: draft, bytes, digest: await sha256Hex(bytes), key: recordKey(draft) };
}
