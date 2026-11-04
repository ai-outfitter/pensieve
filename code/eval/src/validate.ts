import { canonicalize, sha256Hex } from "./canonical.ts";
import { findCredentials, findSecretKeys } from "./publication.ts";
import {
	CASE_STATUSES,
	CHANGE_VARIABLES,
	CHECK_STATUSES,
	MANIFEST_FILE,
	MODEL_KINDS,
	MODES,
	RECEIPT_FILE,
	RUN_STATUSES,
	SCORER_KINDS,
	STANDARD,
	type Issue,
	type ValidationReport,
} from "./types.ts";

export const HEX64 = /^[0-9a-f]{64}$/;
const HEX40 = /^[0-9a-f]{40}$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** Strict ISO-8601 date-time with an explicit offset. */
export const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** Limits that keep validation bounded on hostile input. EVL-001.8.3. */
export const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
const MAX_DEPTH = 32;

export type Obj = Record<string, unknown>;
export const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Why `value` is not plain, bounded JSON, or null when it is. */
export function jsonProblem(value: unknown, depth = 0): string | null {
	if (depth > MAX_DEPTH) return `nests deeper than ${MAX_DEPTH} levels`;
	if (value === null || typeof value === "string" || typeof value === "boolean") return null;
	if (typeof value === "number") return Number.isFinite(value) ? null : "contains a non-finite number";
	if (Array.isArray(value) || isObj(value)) {
		for (const member of Object.values(value)) {
			const problem = jsonProblem(member, depth + 1);
			if (problem) return problem;
		}
		return null;
	}
	return `contains a ${typeof value}, which is not JSON`;
}

/** Hand-written schema walker. Each helper records an issue and returns whether the value is usable. */
export class Checker {
	readonly issues: Issue[] = [];
	readonly file: string;
	constructor(file: string) {
		this.file = file;
	}

	fail(field: string, message: string): false {
		this.issues.push({ file: this.file, field, message });
		return false;
	}
	/** An object with exactly the known keys. EVL-001.1.6. */
	obj(v: unknown, field: string, keys: readonly string[], optional: readonly string[] = []): v is Obj {
		if (!isObj(v)) return this.fail(field, "must be an object");
		for (const key of Object.keys(v)) {
			if (!keys.includes(key) && !optional.includes(key)) this.fail(field ? `${field}.${key}` : key, "is not a known field");
		}
		return true;
	}
	arr(v: unknown, field: string): v is unknown[] {
		return Array.isArray(v) || this.fail(field, "must be an array");
	}
	str(v: unknown, field: string, pattern?: RegExp): v is string {
		if (typeof v !== "string" || v.length === 0) return this.fail(field, "must be a non-empty string");
		if (pattern && !pattern.test(v)) return this.fail(field, `must match ${pattern}`);
		return true;
	}
	strOrNull(v: unknown, field: string, pattern?: RegExp): boolean {
		if (v === null) return true;
		if (typeof v !== "string") return this.fail(field, "must be a string or null");
		return this.str(v, field, pattern);
	}
	oneOf<T extends string>(v: unknown, field: string, values: readonly T[]): v is T {
		return (typeof v === "string" && (values as readonly string[]).includes(v)) ||
			this.fail(field, `must be one of ${values.join(", ")}`);
	}
	int(v: unknown, field: string, min = 0): v is number {
		return (Number.isInteger(v) && (v as number) >= min) || this.fail(field, `must be an integer >= ${min}`);
	}
	bool(v: unknown, field: string): v is boolean {
		return typeof v === "boolean" || this.fail(field, "must be a boolean");
	}
	time(v: unknown, field: string): v is string {
		return (typeof v === "string" && TIMESTAMP.test(v) && !Number.isNaN(Date.parse(v))) ||
			this.fail(field, "must be an ISO-8601 date-time with an offset, like 2026-10-30T15:00:00Z");
	}
	strings(v: unknown, field: string): v is string[] {
		if (!this.arr(v, field)) return false;
		return v.every((s, i) => this.str(s, `${field}[${i}]`));
	}
	/** A list of objects; `each` runs on every member that is an object with known keys. */
	list(v: unknown, field: string, keys: readonly string[], each: (o: Obj, f: string) => void, optional: readonly string[] = []): void {
		if (!this.arr(v, field)) return;
		v.forEach((item, i) => {
			if (this.obj(item, `${field}[${i}]`, keys, optional)) each(item, `${field}[${i}]`);
		});
	}
}

/** A bundle-relative path that cannot escape the bundle. EVL-001.2.3. */
export function isSafePath(path: string): boolean {
	if (path.length === 0 || path.startsWith("/") || path.includes("\\") || /^[A-Za-z]:/.test(path)) return false;
	return path.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

const KEYS = {
	manifest: ["standard", "run", "mode", "subject", "dataset", "scorers", "model", "prompts", "change", "results", "gaps", "summary", "artifacts"],
	run: ["id", "attempt", "status", "started_at", "ended_at", "previous", "regrade_of"],
	subject: ["kind", "id", "version", "definition_digest", "source"],
	source: ["repository", "commit", "dirty", "paths"],
	dataset: ["id", "revision", "digest", "cases"],
	scorer: ["id", "version", "kind"],
	model: ["kind", "provider", "id", "configuration", "recordings_digest"],
	prompt: ["step", "digest", "path"],
	change: ["variable", "baseline", "description"],
	result: ["case", "status", "checks", "artifacts"],
	check: ["scorer", "status"],
	gap: ["case", "class", "reason"],
	summary: ["cases", "pass", "fail", "error", "skipped"],
	artifact: ["path", "digest", "size", "media_type"],
} as const;

/**
 * Validate a manifest value against the schema and its own internal
 * consistency (EVL-001.1–4). Never throws: any input, however malformed,
 * yields issues. It does not look at artifact bytes; see `validateBundleFiles`.
 */
export function validateManifest(value: unknown): Issue[] {
	const c = new Checker(MANIFEST_FILE);
	const problem = jsonProblem(value);
	if (problem) return [{ file: MANIFEST_FILE, message: problem }];
	if (!c.obj(value, "", KEYS.manifest)) return c.issues;
	const m = value;

	// EVL-001.1.3: never guess at an unknown standard.
	if (m.standard !== STANDARD) {
		c.fail("standard", `unknown standard ${JSON.stringify(m.standard)}; expected ${STANDARD}`);
		return c.issues;
	}

	const run = m.run;
	if (c.obj(run, "run", KEYS.run)) {
		c.str(run.id, "run.id", RUN_ID);
		c.int(run.attempt, "run.attempt", 1);
		c.oneOf(run.status, "run.status", RUN_STATUSES);
		const started = c.time(run.started_at, "run.started_at");
		if (run.ended_at !== null && c.time(run.ended_at, "run.ended_at") && started && Date.parse(run.ended_at) < Date.parse(run.started_at as string)) {
			c.fail("run.ended_at", "is before run.started_at");
		}
		for (const key of ["previous", "regrade_of"] as const) {
			c.strOrNull(run[key], `run.${key}`, RUN_ID);
			if (run[key] !== null && run[key] === run.id) c.fail(`run.${key}`, "must not refer to the run itself");
		}
		// EVL-001.4.2: status consistency that needs only the run.
		if (run.status === "complete" && run.ended_at === null) c.fail("run.ended_at", "is required when status is complete");
		if (run.status === "running" && run.ended_at !== null) c.fail("run.ended_at", "must be null while running");
	}

	c.oneOf(m.mode, "mode", MODES);

	if (c.obj(m.subject, "subject", KEYS.subject)) {
		const s = m.subject;
		c.str(s.kind, "subject.kind");
		c.str(s.id, "subject.id");
		c.str(s.version, "subject.version");
		c.str(s.definition_digest, "subject.definition_digest", HEX64);
		if (c.obj(s.source, "subject.source", KEYS.source)) {
			c.str(s.source.repository, "subject.source.repository");
			c.str(s.source.commit, "subject.source.commit", HEX40);
			c.bool(s.source.dirty, "subject.source.dirty");
			c.strings(s.source.paths, "subject.source.paths");
		}
	}

	const cases = new Set<string>();
	if (c.obj(m.dataset, "dataset", KEYS.dataset)) {
		const d = m.dataset;
		c.str(d.id, "dataset.id");
		c.str(d.revision, "dataset.revision");
		c.str(d.digest, "dataset.digest", HEX64);
		if (c.strings(d.cases, "dataset.cases")) {
			for (const id of d.cases) {
				if (cases.has(id)) c.fail("dataset.cases", `duplicate case ${id}`);
				cases.add(id);
			}
		}
	}

	const scorers = new Set<string>();
	c.list(m.scorers, "scorers", KEYS.scorer, (s, f) => {
		c.str(s.version, `${f}.version`);
		c.oneOf(s.kind, `${f}.kind`, SCORER_KINDS);
		if (!c.str(s.id, `${f}.id`)) return;
		if (scorers.has(s.id)) c.fail(`${f}.id`, `duplicate scorer ${s.id}`);
		scorers.add(s.id);
	});

	if (c.obj(m.model, "model", KEYS.model)) {
		const model = m.model;
		c.oneOf(model.kind, "model.kind", MODEL_KINDS);
		c.strOrNull(model.provider, "model.provider");
		c.strOrNull(model.id, "model.id");
		if (!isObj(model.configuration)) c.fail("model.configuration", "must be an object");
		c.strOrNull(model.recordings_digest, "model.recordings_digest", HEX64);

		// EVL-001.3: the mode and the model description must agree, so a replay
		// can never pass for a live run or the other way round.
		if (m.mode === "recorded") {
			if (model.kind !== "recorded") c.fail("model.kind", "must be \"recorded\" in recorded mode");
			if (model.provider !== null) c.fail("model.provider", "must be null in recorded mode");
			if (model.id !== null) c.fail("model.id", "must be null in recorded mode");
			if (model.recordings_digest === null) c.fail("model.recordings_digest", "is required in recorded mode");
		} else if (m.mode === "real-model" || m.mode === "live-provider") {
			if (model.kind !== "provider") c.fail("model.kind", `must be "provider" in ${m.mode} mode`);
			if (model.provider === null) c.fail("model.provider", `is required in ${m.mode} mode`);
			if (model.id === null) c.fail("model.id", `is required in ${m.mode} mode`);
			if (model.recordings_digest !== null) c.fail("model.recordings_digest", `must be null in ${m.mode} mode`);
		}
	}

	// Artifact list first: results and prompts are checked against it.
	const artifacts = new Map<string, unknown>();
	c.list(m.artifacts, "artifacts", KEYS.artifact, (a, f) => {
		c.str(a.digest, `${f}.digest`, HEX64);
		c.int(a.size, `${f}.size`);
		c.str(a.media_type, `${f}.media_type`);
		if (!c.str(a.path, `${f}.path`)) return;
		if (!isSafePath(a.path)) c.fail(`${f}.path`, `${a.path} escapes the bundle or is not a plain relative path`);
		if (a.path === MANIFEST_FILE || a.path === RECEIPT_FILE) c.fail(`${f}.path`, `${a.path} must not be listed`);
		if (artifacts.has(a.path)) c.fail(`${f}.path`, `duplicate artifact ${a.path}`);
		artifacts.set(a.path, a.digest);
	});

	const steps = new Set<string>();
	c.list(m.prompts, "prompts", KEYS.prompt, (p, f) => {
		if (c.str(p.step, `${f}.step`)) {
			if (steps.has(p.step)) c.fail(`${f}.step`, `duplicate prompt step ${p.step}`);
			steps.add(p.step);
		}
		c.str(p.digest, `${f}.digest`, HEX64);
		if (!c.str(p.path, `${f}.path`)) return;
		if (!artifacts.has(p.path)) c.fail(`${f}.path`, `${p.path} is not listed in artifacts`);
		else if (artifacts.get(p.path) !== p.digest) c.fail(`${f}.digest`, `does not match the digest of artifact ${p.path}`);
	});

	if (m.change !== null && c.obj(m.change, "change", KEYS.change)) {
		c.oneOf(m.change.variable, "change.variable", CHANGE_VARIABLES);
		c.str(m.change.baseline, "change.baseline", RUN_ID);
		c.str(m.change.description, "change.description");
	}

	const counts = { cases: 0, pass: 0, fail: 0, error: 0, skipped: 0 };
	const resulted = new Set<string>();
	if (c.arr(m.results, "results")) counts.cases = m.results.length;
	c.list(m.results, "results", KEYS.result, (r, f) => {
		if (c.str(r.case, `${f}.case`)) {
			if (!cases.has(r.case)) c.fail(`${f}.case`, `${r.case} is not in dataset.cases`);
			if (resulted.has(r.case)) c.fail(`${f}.case`, `duplicate result for ${r.case}`);
			resulted.add(r.case);
		}
		const status = c.oneOf(r.status, `${f}.status`, CASE_STATUSES) ? r.status : null;
		if (status) counts[status]++;
		if (c.strings(r.artifacts, `${f}.artifacts`)) {
			r.artifacts.forEach((p, j) => {
				if (!artifacts.has(p)) c.fail(`${f}.artifacts[${j}]`, `${p} is not listed in artifacts`);
			});
		}
		const statuses: string[] = [];
		const scored = new Map<string, number>();
		c.list(r.checks, `${f}.checks`, KEYS.check, (k, g) => {
			if (c.str(k.scorer, `${g}.scorer`)) {
				if (!scorers.has(k.scorer)) c.fail(`${g}.scorer`, `${k.scorer} is not in scorers`);
				scored.set(k.scorer, (scored.get(k.scorer) ?? 0) + 1);
			}
			if (c.oneOf(k.status, `${g}.status`, CHECK_STATUSES)) statuses.push(k.status);
			if (k.reason !== undefined && typeof k.reason !== "string") c.fail(`${g}.reason`, "must be a string");
		}, ["reason"]);
		// EVL-001.2.6: exactly one check per declared scorer.
		for (const id of scorers) {
			const n = scored.get(id) ?? 0;
			if (n !== 1) c.fail(`${f}.checks`, `has ${n} checks for scorer ${id}; expected exactly 1`);
		}
		// EVL-001.4.4: the case status follows from its checks.
		const has = (s: string) => statuses.includes(s);
		if (status === "pass") {
			const bad = statuses.find((s) => s === "fail" || s === "error" || s === "pending");
			if (bad) c.fail(`${f}.status`, `is pass but a check is ${bad}`);
			else if (!has("pass")) c.fail(`${f}.status`, "is pass but no check passed");
		}
		if (status === "fail" && !has("fail")) c.fail(`${f}.status`, "is fail but no check failed");
		if (status === "error" && !has("error")) c.fail(`${f}.status`, "is error but no check errored");
		if (status !== "error" && status !== "pass" && has("error") && !has("fail")) {
			c.fail(`${f}.status`, `is ${status} but a check errored and none failed; expected error`);
		}
	});

	c.list(m.gaps, "gaps", KEYS.gap, (g, f) => {
		if (g.case !== null && c.str(g.case, `${f}.case`) && !cases.has(g.case)) c.fail(`${f}.case`, `${g.case} is not in dataset.cases`);
		c.str(g.class, `${f}.class`);
		c.str(g.reason, `${f}.reason`);
	});

	// EVL-001.4.3: the summary is derived, so it must agree with the results.
	if (c.obj(m.summary, "summary", KEYS.summary) && Array.isArray(m.results)) {
		for (const [key, n] of Object.entries(counts)) {
			const actual = m.summary[key];
			if (actual !== n) c.fail(`summary.${key}`, `is ${JSON.stringify(actual) ?? "missing"} but results give ${n}`);
		}
	}

	// EVL-001.4.2: a complete run has a result for every case.
	if (isObj(run) && run.status === "complete") {
		for (const id of cases) if (!resulted.has(id)) c.fail("results", `complete run has no result for case ${id}`);
	}

	return c.issues;
}

export interface BundleFiles {
	/** Every file in the bundle, keyed by bundle-relative path, including manifest.json and receipt.json. */
	files: Map<string, Uint8Array>;
	/** Problems found while gathering files (symlinks, unreadable entries). */
	issues?: Issue[];
}

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder("utf-8", { fatal: true });
const LOOSE = new TextDecoder();

export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
	return a.byteLength === b.byteLength && a.every((x, i) => x === b[i]);
}

export function parseJson(bytes: Uint8Array): { value: unknown } | { error: string } {
	try {
		return { value: JSON.parse(DECODER.decode(bytes)) };
	} catch (error) {
		return { error: `not valid JSON: ${error instanceof Error ? error.message : String(error)}` };
	}
}

/**
 * Validate a whole bundle held in memory (EVL-001.1–6). Pure: works on bytes,
 * so the same code validates a directory, a fetched archive, or an object store.
 * Never throws on malformed content.
 */
export async function validateBundleFiles(
	bundle: BundleFiles,
	options: { publication?: boolean } = {},
): Promise<ValidationReport> {
	const issues: Issue[] = [...(bundle.issues ?? [])];
	let manifest: Obj | null = null;
	const report = (): ValidationReport => {
		const run = isObj(manifest?.run) ? manifest.run : {};
		const pick = <T extends string>(v: unknown, values: readonly T[]) => (values as readonly unknown[]).includes(v) ? (v as T) : null;
		return {
			valid: issues.length === 0,
			run: typeof run.id === "string" ? run.id : null,
			mode: pick(manifest?.mode, MODES),
			status: pick(run.status, RUN_STATUSES),
			issues,
		};
	};

	const raw = bundle.files.get(MANIFEST_FILE);
	if (!raw) {
		issues.push({ file: MANIFEST_FILE, message: "missing" });
		return report();
	}
	if (raw.byteLength > MAX_MANIFEST_BYTES) {
		issues.push({ file: MANIFEST_FILE, message: `is larger than ${MAX_MANIFEST_BYTES} bytes` });
		return report();
	}
	const parsed = parseJson(raw);
	if ("error" in parsed) {
		issues.push({ file: MANIFEST_FILE, message: parsed.error });
		return report();
	}
	const manifestIssues = validateManifest(parsed.value);
	issues.push(...manifestIssues);
	// Past the shape and bounds checks the value is a bounded JSON object, so
	// canonicalize cannot throw on it.
	if (!isObj(parsed.value) || parsed.value.standard !== STANDARD || jsonProblem(parsed.value)) return report();
	manifest = parsed.value;

	// EVL-001.1.2: the manifest bytes are exactly its canonical form (no BOM, no whitespace).
	const canonical = ENCODER.encode(canonicalize(manifest));
	if (!sameBytes(raw, canonical)) issues.push({ file: MANIFEST_FILE, message: "is not canonical JSON" });

	const listed = new Map<string, Obj>();
	if (Array.isArray(manifest.artifacts)) {
		for (const a of manifest.artifacts) if (isObj(a) && typeof a.path === "string" && isSafePath(a.path)) listed.set(a.path, a);
	}

	// EVL-001.2.1: every listed artifact present with matching size and digest.
	for (const [path, artifact] of listed) {
		const bytes = bundle.files.get(path);
		if (!bytes) {
			issues.push({ file: path, message: "listed in manifest.artifacts but missing" });
			continue;
		}
		if (bytes.byteLength !== artifact.size) issues.push({ file: path, field: "size", message: `is ${bytes.byteLength} bytes, manifest says ${artifact.size}` });
		if ((await sha256Hex(bytes)) !== artifact.digest) issues.push({ file: path, field: "digest", message: "content does not match the manifest digest" });
	}

	// EVL-001.2.2: nothing unlisted.
	for (const path of bundle.files.keys()) {
		if (path === MANIFEST_FILE || path === RECEIPT_FILE || listed.has(path)) continue;
		issues.push({ file: path, message: "not listed in manifest.artifacts" });
	}

	// EVL-001.5.1: an optional receipt must name this exact manifest.
	const receipt = bundle.files.get(RECEIPT_FILE);
	if (receipt) {
		const r = parseJson(receipt);
		const digest = await sha256Hex(canonical);
		if ("error" in r) issues.push({ file: RECEIPT_FILE, message: r.error });
		else if (!isObj(r.value) || r.value.manifest_digest !== digest) {
			issues.push({ file: RECEIPT_FILE, field: "manifest_digest", message: `does not match the canonical manifest digest ${digest}` });
		}
	}

	// EVL-001.6: publication profile.
	if (options.publication) {
		const source = isObj(manifest.subject) && isObj(manifest.subject.source) ? manifest.subject.source : {};
		if (source.dirty !== false) issues.push({ file: MANIFEST_FILE, field: "subject.source.dirty", message: "must be false for publication" });
		for (const [path, bytes] of bundle.files) {
			for (const finding of findCredentials(path)) issues.push({ file: path, message: `path looks like a credential (${finding}); not publishable` });
			const text = LOOSE.decode(bytes);
			for (const finding of findCredentials(text)) issues.push({ file: path, message: `looks like a credential (${finding}); not publishable` });
			if (!path.endsWith(".json")) continue;
			const json = parseJson(bytes);
			if ("value" in json) {
				for (const key of findSecretKeys(json.value)) issues.push({ file: path, field: key, message: "is a secret-like field with a value; not publishable" });
			}
		}
	}

	return report();
}
