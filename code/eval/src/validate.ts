import { canonicalize, sha256Hex } from "./canonical.ts";
import { findCredentials } from "./publication.ts";
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
	type Manifest,
	type ValidationReport,
} from "./types.ts";

const HEX64 = /^[0-9a-f]{64}$/;
const HEX40 = /^[0-9a-f]{40}$/;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** Hand-written schema walker. Each helper records an issue and returns whether the value is usable. */
class Checker {
	readonly issues: Issue[] = [];
	readonly file: string;
	constructor(file: string) {
		this.file = file;
	}

	fail(field: string, message: string): false {
		this.issues.push({ file: this.file, field, message });
		return false;
	}
	obj(v: unknown, field: string): v is Obj {
		return isObj(v) || this.fail(field, "must be an object");
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
		return v === null || this.str(v, field, pattern);
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
	date(v: unknown, field: string): boolean {
		return (this.str(v, field) && !Number.isNaN(Date.parse(v))) || this.fail(field, "must be an ISO-8601 time");
	}
	strings(v: unknown, field: string): v is string[] {
		if (!this.arr(v, field)) return false;
		return v.every((s, i) => this.str(s, `${field}[${i}]`));
	}
}

/** A bundle-relative path that cannot escape the bundle. EVL-001.2.3. */
export function isSafePath(path: string): boolean {
	if (path.length === 0 || path.startsWith("/") || path.includes("\\") || /^[A-Za-z]:/.test(path)) return false;
	return path.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

/**
 * Validate a parsed manifest against the schema and its own internal
 * consistency (EVL-001.1–4). It does not look at artifact bytes; see
 * `validateBundleFiles` for that.
 */
export function validateManifest(value: unknown): Issue[] {
	const c = new Checker(MANIFEST_FILE);
	if (!c.obj(value, "")) return c.issues;
	const m = value;

	// EVL-001.1.3: never guess at an unknown standard.
	if (m.standard !== STANDARD) {
		c.fail("standard", `unknown standard ${JSON.stringify(m.standard)}; expected ${STANDARD}`);
		return c.issues;
	}

	const run = m.run;
	if (c.obj(run, "run")) {
		c.str(run.id, "run.id", /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
		c.int(run.attempt, "run.attempt", 1);
		c.oneOf(run.status, "run.status", RUN_STATUSES);
		c.date(run.started_at, "run.started_at");
		if (run.ended_at !== null) c.date(run.ended_at, "run.ended_at");
		for (const key of ["previous", "regrade_of"] as const) {
			c.strOrNull(run[key], `run.${key}`);
			if (run[key] !== null && run[key] === run.id) c.fail(`run.${key}`, "must not refer to the run itself");
		}
	}

	c.oneOf(m.mode, "mode", MODES);

	const subject = m.subject;
	if (c.obj(subject, "subject")) {
		c.str(subject.kind, "subject.kind");
		c.str(subject.id, "subject.id");
		c.str(subject.version, "subject.version");
		c.str(subject.definition_digest, "subject.definition_digest", HEX64);
		const src = subject.source;
		if (c.obj(src, "subject.source")) {
			c.str(src.repository, "subject.source.repository");
			c.str(src.commit, "subject.source.commit", HEX40);
			c.bool(src.dirty, "subject.source.dirty");
			c.strings(src.paths, "subject.source.paths");
		}
	}

	const cases = new Set<string>();
	const dataset = m.dataset;
	if (c.obj(dataset, "dataset")) {
		c.str(dataset.id, "dataset.id");
		c.str(dataset.revision, "dataset.revision");
		c.str(dataset.digest, "dataset.digest", HEX64);
		if (c.strings(dataset.cases, "dataset.cases")) {
			for (const id of dataset.cases) {
				if (cases.has(id)) c.fail("dataset.cases", `duplicate case ${id}`);
				cases.add(id);
			}
		}
	}

	const scorers = new Set<string>();
	if (c.arr(m.scorers, "scorers")) {
		m.scorers.forEach((s, i) => {
			const f = `scorers[${i}]`;
			if (!c.obj(s, f)) return;
			c.str(s.version, `${f}.version`);
			c.oneOf(s.kind, `${f}.kind`, SCORER_KINDS);
			if (!c.str(s.id, `${f}.id`)) return;
			if (scorers.has(s.id)) c.fail(`${f}.id`, `duplicate scorer ${s.id}`);
			scorers.add(s.id);
		});
	}

	const model = m.model;
	if (c.obj(model, "model")) {
		c.oneOf(model.kind, "model.kind", MODEL_KINDS);
		c.strOrNull(model.provider, "model.provider");
		c.strOrNull(model.id, "model.id");
		c.obj(model.configuration, "model.configuration");
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
	const artifacts = new Map<string, string>();
	if (c.arr(m.artifacts, "artifacts")) {
		m.artifacts.forEach((a, i) => {
			const f = `artifacts[${i}]`;
			if (!c.obj(a, f)) return;
			c.str(a.digest, `${f}.digest`, HEX64);
			c.int(a.size, `${f}.size`);
			c.str(a.media_type, `${f}.media_type`);
			if (!c.str(a.path, `${f}.path`)) return;
			if (!isSafePath(a.path)) c.fail(`${f}.path`, `${a.path} escapes the bundle or is not a plain relative path`);
			if (a.path === MANIFEST_FILE || a.path === RECEIPT_FILE) c.fail(`${f}.path`, `${a.path} must not be listed`);
			if (artifacts.has(a.path)) c.fail(`${f}.path`, `duplicate artifact ${a.path}`);
			artifacts.set(a.path, String(a.digest));
		});
	}

	if (c.arr(m.prompts, "prompts")) {
		m.prompts.forEach((p, i) => {
			const f = `prompts[${i}]`;
			if (!c.obj(p, f)) return;
			c.str(p.step, `${f}.step`);
			c.str(p.digest, `${f}.digest`, HEX64);
			if (!c.str(p.path, `${f}.path`)) return;
			const listed = artifacts.get(p.path);
			if (listed === undefined) c.fail(`${f}.path`, `${p.path} is not listed in artifacts`);
			else if (listed !== p.digest) c.fail(`${f}.digest`, `does not match the digest of artifact ${p.path}`);
		});
	}

	if (m.change !== null && c.obj(m.change, "change")) {
		c.oneOf(m.change.variable, "change.variable", CHANGE_VARIABLES);
		c.str(m.change.baseline, "change.baseline");
		c.str(m.change.description, "change.description");
	}

	const counts = { pass: 0, fail: 0, error: 0, skipped: 0 };
	const resulted = new Set<string>();
	if (c.arr(m.results, "results")) {
		m.results.forEach((r, i) => {
			const f = `results[${i}]`;
			if (!c.obj(r, f)) return;
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
			if (!c.arr(r.checks, `${f}.checks`)) return;
			const statuses: string[] = [];
			r.checks.forEach((k, j) => {
				const g = `${f}.checks[${j}]`;
				if (!c.obj(k, g)) return;
				if (c.str(k.scorer, `${g}.scorer`) && !scorers.has(k.scorer)) c.fail(`${g}.scorer`, `${k.scorer} is not in scorers`);
				if (c.oneOf(k.status, `${g}.status`, CHECK_STATUSES)) statuses.push(k.status);
				if (k.reason !== undefined && typeof k.reason !== "string") c.fail(`${g}.reason`, "must be a string");
			});
			// EVL-001.4.4: a pass needs a passing check and nothing failed, errored, or pending.
			if (status === "pass") {
				const bad = statuses.find((s) => s === "fail" || s === "error" || s === "pending");
				if (bad) c.fail(`${f}.status`, `is pass but a check is ${bad}`);
				else if (!statuses.includes("pass")) c.fail(`${f}.status`, "is pass but no check passed");
			}
		});
	}

	if (c.arr(m.gaps, "gaps")) {
		m.gaps.forEach((g, i) => {
			const f = `gaps[${i}]`;
			if (!c.obj(g, f)) return;
			if (g.case !== null && c.str(g.case, `${f}.case`) && !cases.has(g.case)) c.fail(`${f}.case`, `${g.case} is not in dataset.cases`);
			c.str(g.class, `${f}.class`);
			c.str(g.reason, `${f}.reason`);
		});
	}

	// EVL-001.4.3: the summary is derived, so it must agree with the results.
	const summary = m.summary;
	if (c.obj(summary, "summary") && Array.isArray(m.results)) {
		const expected = { cases: m.results.length, ...counts };
		for (const [key, n] of Object.entries(expected)) {
			if (summary[key] !== n) c.fail(`summary.${key}`, `is ${JSON.stringify(summary[key])} but results give ${n}`);
		}
	}

	// EVL-001.4.2: status consistency.
	if (isObj(run)) {
		if (run.status === "complete") {
			if (run.ended_at === null) c.fail("run.ended_at", "is required when status is complete");
			for (const id of cases) if (!resulted.has(id)) c.fail("results", `complete run has no result for case ${id}`);
		}
		if (run.status === "running" && run.ended_at !== null) c.fail("run.ended_at", "must be null while running");
	}

	return c.issues;
}

export interface BundleFiles {
	/** Every file in the bundle, keyed by bundle-relative path, including manifest.json and receipt.json. */
	files: Map<string, Uint8Array>;
	/** Problems found while gathering files (symlinks, unreadable entries). */
	issues?: Issue[];
}

const DECODER = new TextDecoder("utf-8", { fatal: true });

/**
 * Validate a whole bundle held in memory (EVL-001.1–6). Pure: works on bytes,
 * so the same code validates a directory, a fetched archive, or an object store.
 */
export async function validateBundleFiles(
	bundle: BundleFiles,
	options: { publication?: boolean } = {},
): Promise<ValidationReport> {
	const issues: Issue[] = [...(bundle.issues ?? [])];
	const report = (m?: Manifest): ValidationReport => ({
		valid: issues.length === 0,
		run: m?.run?.id ?? null,
		mode: m?.mode ?? null,
		status: m?.run?.status ?? null,
		issues,
	});

	const raw = bundle.files.get(MANIFEST_FILE);
	if (!raw) {
		issues.push({ file: MANIFEST_FILE, message: "missing" });
		return report();
	}
	let manifest: Manifest;
	try {
		manifest = JSON.parse(DECODER.decode(raw));
	} catch (error) {
		issues.push({ file: MANIFEST_FILE, message: `not valid JSON: ${(error as Error).message}` });
		return report();
	}
	// EVL-001.1.2: the manifest bytes are exactly its canonical form.
	const canonical = canonicalize(manifest);
	if (DECODER.decode(raw) !== canonical) issues.push({ file: MANIFEST_FILE, message: "is not canonical JSON" });

	issues.push(...validateManifest(manifest));
	const listed = new Map<string, Manifest["artifacts"][number]>();
	if (Array.isArray(manifest.artifacts)) for (const a of manifest.artifacts) if (isObj(a) && typeof a.path === "string") listed.set(a.path, a);

	// EVL-001.2.1: every listed artifact present with matching size and digest.
	for (const [path, artifact] of listed) {
		if (!isSafePath(path)) continue; // already reported
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
		try {
			const parsed = JSON.parse(DECODER.decode(receipt));
			if (!isObj(parsed) || !Array.isArray(parsed.statements)) issues.push({ file: RECEIPT_FILE, field: "statements", message: "must be an array" });
			const digest = await sha256Hex(canonical);
			if (!isObj(parsed) || parsed.manifest_digest !== digest) {
				issues.push({ file: RECEIPT_FILE, field: "manifest_digest", message: `does not match the canonical manifest digest ${digest}` });
			}
		} catch (error) {
			issues.push({ file: RECEIPT_FILE, message: `not valid JSON: ${(error as Error).message}` });
		}
	}

	// EVL-001.6: publication profile.
	if (options.publication) {
		if (manifest.subject?.source?.dirty !== false) {
			issues.push({ file: MANIFEST_FILE, field: "subject.source.dirty", message: "must be false for publication" });
		}
		for (const [path, bytes] of bundle.files) {
			for (const finding of findCredentials(new TextDecoder().decode(bytes))) {
				issues.push({ file: path, message: `looks like a credential (${finding}); not publishable` });
			}
		}
	}

	return report(manifest);
}
