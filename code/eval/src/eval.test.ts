import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { canonicalDigest, canonicalize, compareManifests, sha256Hex, MAX_MANIFEST_BYTES, STANDARD, validateBundleFiles, validateManifest, type Manifest } from "./index.ts";
import { addArtifacts, createBundle, finalizeBundle, readManifest, validateBundle, writeBundle, type ManifestInput } from "./node.ts";
import { fixture, tempRoot } from "./test-fixture.ts";
import { canonicalize as serverCanonicalize } from "../../server/src/canonical.ts";

async function written(mutate: (m: ManifestInput) => void = () => {}, runId?: string) {
	const { manifest, files } = await fixture(runId);
	mutate(manifest);
	const dir = join(await tempRoot(), manifest.run.id);
	return { dir, manifest: await writeBundle(dir, { manifest, files }) };
}

/** Rewrite manifest.json in place (canonical), the way a careless tool would. */
async function rewriteManifest(dir: string, mutate: (m: Manifest) => void) {
	const m = await readManifest(dir);
	mutate(m);
	await writeFile(join(dir, "manifest.json"), canonicalize(m));
}

const messages = (r: { issues: { file: string; field?: string; message: string }[] }) =>
	r.issues.map((i) => `${i.file} ${i.field ?? ""} ${i.message}`);

describe("validation", () => {
	test("a fixture bundle validates", async () => {
		const { dir } = await written();
		const report = await validateBundle(dir);
		expect(report.issues).toEqual([]);
		expect(report).toMatchObject({ valid: true, mode: "recorded", status: "complete" });
	});

	test("modified artifact bytes fail", async () => {
		// THIS TEST VALIDATES A HARD REQUIREMENT (EVL-001.2.1)
		// YOU MUST NOT MODIFY THIS TEST UNLESS THE REQUIREMENT CHANGES
		const { dir } = await written();
		await writeFile(join(dir, "cases/declined/output.json"), '{"reply":"edited"}');
		const report = await validateBundle(dir);
		expect(report.valid).toBe(false);
		expect(report.issues).toContainEqual(expect.objectContaining({ file: "cases/declined/output.json", field: "digest" }));
	});

	test("a missing artifact fails", async () => {
		// THIS TEST VALIDATES A HARD REQUIREMENT (EVL-001.2.1)
		// YOU MUST NOT MODIFY THIS TEST UNLESS THE REQUIREMENT CHANGES
		const { dir } = await written();
		await unlink(join(dir, "report.md"));
		const report = await validateBundle(dir);
		expect(report.valid).toBe(false);
		expect(messages(report)).toContainEqual(expect.stringContaining("report.md  listed in manifest.artifacts but missing"));
	});

	test("an unlisted file fails", async () => {
		// THIS TEST VALIDATES A HARD REQUIREMENT (EVL-001.2.2)
		// YOU MUST NOT MODIFY THIS TEST UNLESS THE REQUIREMENT CHANGES
		const { dir } = await written();
		await writeFile(join(dir, "cases/declined/extra.json"), "{}");
		const report = await validateBundle(dir);
		expect(report.valid).toBe(false);
		expect(report.issues).toContainEqual({ file: "cases/declined/extra.json", message: "not listed in manifest.artifacts" });
	});

	test("a path that escapes the bundle fails, in the manifest or through a symlink", async () => {
		// THIS TEST VALIDATES A HARD REQUIREMENT (EVL-001.2.3)
		// YOU MUST NOT MODIFY THIS TEST UNLESS THE REQUIREMENT CHANGES
		const { dir } = await written();
		await rewriteManifest(dir, (m) => m.artifacts.push({ path: "../outside.json", digest: "0".repeat(64), size: 2, media_type: "application/json" }));
		const escaped = await validateBundle(dir);
		expect(escaped.valid).toBe(false);
		expect(escaped.issues).toContainEqual(expect.objectContaining({ field: expect.stringMatching(/^artifacts\[\d+\]\.path$/), message: expect.stringContaining("escapes") }));

		const other = await written();
		await symlink("/etc/hostname", join(other.dir, "cases/link.json"));
		const linked = await validateBundle(other.dir);
		expect(linked.valid).toBe(false);
		expect(linked.issues).toContainEqual(expect.objectContaining({ file: "cases/link.json", message: expect.stringContaining("symbolic link") }));
	});

	test("a recorded-mode manifest that names a provider fails", async () => {
		// THIS TEST VALIDATES A HARD REQUIREMENT (EVL-001.3.2)
		// YOU MUST NOT MODIFY THIS TEST UNLESS THE REQUIREMENT CHANGES
		const { manifest } = await written();
		manifest.model.provider = "openai";
		manifest.model.id = "gpt-x";
		expect(validateManifest(manifest)).toEqual([
			{ file: "manifest.json", field: "model.provider", message: "must be null in recorded mode" },
			{ file: "manifest.json", field: "model.id", message: "must be null in recorded mode" },
		]);
	});

	test("a real-model manifest without a provider fails", async () => {
		// THIS TEST VALIDATES A HARD REQUIREMENT (EVL-001.3.3)
		// YOU MUST NOT MODIFY THIS TEST UNLESS THE REQUIREMENT CHANGES
		const { manifest } = await written();
		manifest.mode = "real-model";
		manifest.model = { kind: "provider", provider: null, id: "gpt-x", configuration: {}, recordings_digest: null };
		expect(validateManifest(manifest)).toEqual([
			{ file: "manifest.json", field: "model.provider", message: "is required in real-model mode" },
		]);
	});

	test("summary and status inconsistencies fail", async () => {
		// THIS TEST VALIDATES A HARD REQUIREMENT (EVL-001.4.2, EVL-001.4.3, EVL-001.4.4)
		// YOU MUST NOT MODIFY THIS TEST UNLESS THE REQUIREMENT CHANGES
		const { manifest } = await written();
		const broken = structuredClone(manifest);
		broken.summary.pass = 2;
		broken.results[1]!.status = "pass"; // has a failed check
		broken.run.ended_at = null;
		broken.results.pop(); // complete but a case has no result
		const fields = validateManifest(broken).map((i) => i.field);
		expect(fields).toContain("summary.cases");
		expect(fields).toContain("run.ended_at");
		expect(fields).toContain("results");

		const passWithFailedCheck = structuredClone(manifest);
		passWithFailedCheck.results[1]!.status = "pass";
		passWithFailedCheck.summary = { cases: 2, pass: 2, fail: 0, error: 0, skipped: 0 };
		expect(validateManifest(passWithFailedCheck)).toEqual([
			{ file: "manifest.json", field: "results[1].status", message: "is pass but a check is fail" },
		]);
	});

	test("failed and interrupted runs validate as what they are", async () => {
		// THIS TEST VALIDATES A HARD REQUIREMENT (EVL-001.4.7)
		// YOU MUST NOT MODIFY THIS TEST UNLESS THE REQUIREMENT CHANGES
		const { dir } = await written((m) => {
			m.run.status = "interrupted";
			m.run.ended_at = null;
			m.results.pop();
		});
		expect(await validateBundle(dir)).toMatchObject({ valid: true, status: "interrupted", issues: [] });
	});

	test("an unknown standard is rejected rather than guessed at", async () => {
		// THIS TEST VALIDATES A HARD REQUIREMENT (EVL-001.1.3)
		// YOU MUST NOT MODIFY THIS TEST UNLESS THE REQUIREMENT CHANGES
		const { manifest } = await written();
		expect(validateManifest({ ...manifest, standard: "pensieve.evaluation/v9" })[0]).toMatchObject({ field: "standard" });
	});

	test("a receipt that names a different manifest fails", async () => {
		// THIS TEST VALIDATES A HARD REQUIREMENT (EVL-001.5.1)
		// YOU MUST NOT MODIFY THIS TEST UNLESS THE REQUIREMENT CHANGES
		const { dir, manifest } = await written();
		await writeFile(join(dir, "receipt.json"), canonicalize({ manifest_digest: await canonicalDigest(manifest), statements: [] }));
		expect((await validateBundle(dir)).valid).toBe(true);

		await writeFile(join(dir, "receipt.json"), canonicalize({ manifest_digest: "0".repeat(64), statements: [] }));
		const report = await validateBundle(dir);
		expect(report.valid).toBe(false);
		expect(report.issues).toContainEqual(expect.objectContaining({ file: "receipt.json", field: "manifest_digest" }));
	});

	test("the publication profile catches a credential and a dirty source", async () => {
		// THIS TEST VALIDATES A HARD REQUIREMENT (EVL-001.6.2, EVL-001.6.3)
		// YOU MUST NOT MODIFY THIS TEST UNLESS THE REQUIREMENT CHANGES
		const { manifest, files } = await fixture();
		files["cases/declined/trace.json"] = { operations: [{ op: "model.call", headers: { authorization: "sk-proj-abcdefghijklmnopqrstuvwx0123" } }] };
		manifest.subject.source.dirty = true;
		const dir = join(await tempRoot(), manifest.run.id);
		await writeBundle(dir, { manifest, files });

		expect((await validateBundle(dir)).valid).toBe(true);
		const report = await validateBundle(dir, { publication: true });
		expect(report.valid).toBe(false);
		expect(report.issues).toContainEqual(expect.objectContaining({ file: "cases/declined/trace.json", message: expect.stringContaining("OpenAI-style API key") }));
		expect(report.issues).toContainEqual(expect.objectContaining({ field: "subject.source.dirty" }));
	});

	test("manifest.json must be canonical JSON", async () => {
		// THIS TEST VALIDATES A HARD REQUIREMENT (EVL-001.1.2)
		// YOU MUST NOT MODIFY THIS TEST UNLESS THE REQUIREMENT CHANGES
		const { dir, manifest } = await written();
		await writeFile(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
		expect((await validateBundle(dir)).issues).toEqual([{ file: "manifest.json", message: "is not canonical JSON" }]);
	});
});

describe("manifest rules", () => {
	const base = async () => (await written()).manifest;
	const fields = (m: unknown) => validateManifest(m).map((i) => `${i.field}: ${i.message}`);

	test("case status follows from its checks", async () => {
		// THIS TEST VALIDATES A HARD REQUIREMENT (EVL-001.4.4)
		// YOU MUST NOT MODIFY THIS TEST UNLESS THE REQUIREMENT CHANGES
		const m = await base();
		const failWithoutFailure = structuredClone(m);
		failWithoutFailure.results[1]!.checks[0]!.status = "pending";
		expect(fields(failWithoutFailure)).toEqual(["results[1].status: is fail but no check failed"]);

		const errorCheckNotError = structuredClone(m);
		errorCheckNotError.results[1]!.checks[0]!.status = "error";
		expect(fields(errorCheckNotError)).toEqual([
			"results[1].status: is fail but no check failed",
			"results[1].status: is fail but a check errored and none failed; expected error",
		]);

		const errorWithoutError = structuredClone(m);
		errorWithoutError.results[1]!.status = "error";
		errorWithoutError.summary = { cases: 2, pass: 1, fail: 0, error: 1, skipped: 0 };
		expect(fields(errorWithoutError)).toEqual(["results[1].status: is error but no check errored"]);
	});

	test("each result has exactly one check per declared scorer", async () => {
		// THIS TEST VALIDATES A HARD REQUIREMENT (EVL-001.2.6)
		// YOU MUST NOT MODIFY THIS TEST UNLESS THE REQUIREMENT CHANGES
		const m = await base();
		m.results[0]!.checks.pop();
		m.results[1]!.checks.push({ scorer: "consent-grants-no-access", status: "not-applicable" });
		expect(fields(m)).toEqual([
			"results[0].checks: has 0 checks for scorer no-unrequested-writes; expected exactly 1",
			"results[1].checks: has 2 checks for scorer consent-grants-no-access; expected exactly 1",
		]);
	});

	test("malformed manifests yield issues, never exceptions", async () => {
		// THIS TEST VALIDATES A HARD REQUIREMENT (EVL-001.8.3)
		// YOU MUST NOT MODIFY THIS TEST UNLESS THE REQUIREMENT CHANGES
		let deep: unknown = 1;
		for (let i = 0; i < 100_000; i++) deep = [deep];
		const cyclic: Record<string, unknown> = {};
		cyclic.self = cyclic;
		for (const value of [null, [], "x", 1, Number.NaN, { standard: STANDARD, run: Number.POSITIVE_INFINITY }, deep, cyclic, { standard: STANDARD, run: [], results: "x", artifacts: [null, 1] }]) {
			expect(validateManifest(value).length).toBeGreaterThan(0);
		}
		const hostile = ["null", "[]", '{"standard":"pensieve.evaluation/v0","run":1e999}', "[".repeat(50_000) + "]".repeat(50_000), `{"standard":"pensieve.evaluation/v0","x":"${"a".repeat(MAX_MANIFEST_BYTES)}"}`];
		for (const text of hostile) {
			const report = await validateBundleFiles({ files: new Map([["manifest.json", new TextEncoder().encode(text)]]) });
			expect(report.valid).toBe(false);
		}
	});

	test("manifest.json is byte-identical to its canonical encoding", async () => {
		// THIS TEST VALIDATES A HARD REQUIREMENT (EVL-001.1.2)
		// YOU MUST NOT MODIFY THIS TEST UNLESS THE REQUIREMENT CHANGES
		const { dir } = await written();
		const bytes = await readFile(join(dir, "manifest.json"));
		await writeFile(join(dir, "manifest.json"), Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]));
		expect((await validateBundle(dir)).issues).toEqual([{ file: "manifest.json", message: "is not canonical JSON" }]);
	});

	test("unknown fields, loose timestamps, time travel, and duplicate prompt steps are invalid", async () => {
		// THIS TEST VALIDATES A HARD REQUIREMENT (EVL-001.1.6, EVL-001.1.7)
		// YOU MUST NOT MODIFY THIS TEST UNLESS THE REQUIREMENT CHANGES
		const m = (await base()) as unknown as Record<string, any>;
		m.extra = true;
		m.model.temperature = 0;
		m.run.started_at = "2026-10-30 15:00";
		expect(fields(m)).toEqual([
			"extra: is not a known field",
			"run.started_at: must be an ISO-8601 date-time with an offset, like 2026-10-30T15:00:00Z",
			"model.temperature: is not a known field",
		]);

		const late = await base();
		late.run.ended_at = "2026-10-30T14:00:00Z";
		expect(fields(late)).toEqual(["run.ended_at: is before run.started_at"]);

		const twice = await base();
		twice.prompts.push({ ...twice.prompts[0]! });
		expect(fields(twice)).toEqual(["prompts[1].step: duplicate prompt step scan"]);
	});

	test("the publication profile rejects secret-like fields and credential-shaped paths", async () => {
		// THIS TEST VALIDATES A HARD REQUIREMENT (EVL-001.6.4, EVL-001.6.2)
		// YOU MUST NOT MODIFY THIS TEST UNLESS THE REQUIREMENT CHANGES
		const { manifest, files } = await fixture();
		files["cases/declined/trace.json"] = { operations: [{ op: "connector.read", request: { headers: { Authorization: "opaque-value" }, Api_Key: "x" } }] };
		files["cases/declined/ghp_abcdefghijklmnopqrstuvwxyz0123456789.txt"] = "";
		manifest.results[0]!.artifacts.push("cases/declined/ghp_abcdefghijklmnopqrstuvwxyz0123456789.txt");
		const dir = join(await tempRoot(), manifest.run.id);
		await writeBundle(dir, { manifest, files });
		const report = await validateBundle(dir, { publication: true });
		expect(report.issues.map((i) => `${i.file} ${i.field ?? ""}`).sort()).toEqual([
			"cases/declined/ghp_abcdefghijklmnopqrstuvwxyz0123456789.txt ", // the path itself
			"cases/declined/trace.json operations[0].request.Api_Key",
			"cases/declined/trace.json operations[0].request.headers.Authorization",
			"manifest.json ", // which lists that path
		]);
		// maxOutputTokens in model.configuration is not a secret.
		expect(report.issues.some((i) => i.field?.includes("maxOutputTokens"))).toBe(false);
	});
});

describe("writing", () => {
	test("writing the same inputs twice gives byte-identical files", async () => {
		// THIS TEST VALIDATES A HARD REQUIREMENT (EVL-001.1.5)
		// YOU MUST NOT MODIFY THIS TEST UNLESS THE REQUIREMENT CHANGES
		const a = await written();
		const b = await written();
		const list = async (dir: string) => (await readdir(dir, { recursive: true })).sort();
		const paths = await list(a.dir);
		expect(await list(b.dir)).toEqual(paths);
		for (const p of paths) {
			if (!p.includes(".")) continue; // directories
			expect(Buffer.compare(await readFile(join(a.dir, p)), await readFile(join(b.dir, p)))).toBe(0);
		}
	});

	test("an existing bundle directory is never overwritten", async () => {
		// THIS TEST VALIDATES A HARD REQUIREMENT (EVL-001.4.5)
		// YOU MUST NOT MODIFY THIS TEST UNLESS THE REQUIREMENT CHANGES
		const { dir } = await written();
		const { manifest, files } = await fixture();
		await expect(writeBundle(dir, { manifest, files })).rejects.toThrow("already exists");
	});

	test("a running bundle grows and is finalized once, without rewriting artifacts", async () => {
		// THIS TEST VALIDATES A HARD REQUIREMENT (EVL-001.4.6)
		// YOU MUST NOT MODIFY THIS TEST UNLESS THE REQUIREMENT CHANGES
		const { manifest, files } = await fixture();
		const { results, gaps } = manifest;
		const dir = join(await tempRoot(), manifest.run.id);
		const { "report.md": report, "prompts/scan.txt": prompt, ...cases } = files;
		await createBundle(dir, { manifest: { ...manifest, run: { ...manifest.run, status: "running", ended_at: null }, results: [] }, files: { "prompts/scan.txt": prompt! } });
		expect(await validateBundle(dir)).toMatchObject({ valid: true, status: "running" });

		await addArtifacts(dir, cases);
		await expect(addArtifacts(dir, { "prompts/scan.txt": "changed" })).rejects.toThrow("never rewritten");
		const jobPrompt = "Draft the weekly brief from the granted calendar only.\n";
		await expect(finalizeBundle(dir, {
			status: "complete", ended_at: "2026-10-30T15:02:00Z", results, gaps,
			prompts: [{ step: "scan", digest: await sha256Hex(jobPrompt), path: "prompts/job-brief.txt" }],
			files: { "prompts/job-brief.txt": jobPrompt },
		})).rejects.toThrow("duplicate prompt step scan");
		const final = await finalizeBundle(dir, {
			status: "complete", ended_at: "2026-10-30T15:02:00Z", results, gaps,
			prompts: [{ step: "job-brief", digest: await sha256Hex(jobPrompt), path: "prompts/job-brief.txt" }],
			files: { "report.md": report!, "prompts/job-brief.txt": jobPrompt },
		});
		expect(final.prompts.map((p) => p.step)).toEqual(["scan", "job-brief"]);
		expect(await validateBundle(dir)).toMatchObject({ valid: true, status: "complete", issues: [] });
		expect(await readdir(dir)).not.toContainEqual(expect.stringContaining(".tmp"));

		await expect(finalizeBundle(dir, { status: "failed", ended_at: null, results: [], gaps: [] })).rejects.toThrow("only a running bundle");
		await expect(addArtifacts(dir, { "late.txt": "x" })).rejects.toThrow("only a running bundle");
	});

	test("an invalid manifest is refused before anything is written", async () => {
		// THIS TEST VALIDATES A HARD REQUIREMENT (EVL-001.4.8)
		// YOU MUST NOT MODIFY THIS TEST UNLESS THE REQUIREMENT CHANGES
		const { manifest, files } = await fixture();
		const dir = join(await tempRoot(), manifest.run.id);
		const running = { ...manifest, run: { ...manifest.run, status: "running" as const, ended_at: null }, results: [] };
		await expect(createBundle(dir, { manifest: { ...running, mode: "real-model" }, files })).rejects.toThrow("model.provider");
		expect(await stat(dir).catch(() => null)).toBeNull();

		await createBundle(dir, { manifest: running, files });
		const before = await readFile(join(dir, "manifest.json"));
		const bad = structuredClone(manifest.results);
		bad[0]!.case = "not-a-case";
		await expect(finalizeBundle(dir, { status: "complete", ended_at: "2026-10-30T15:02:00Z", results: bad, gaps: [] })).rejects.toThrow("not in dataset.cases");
		expect(Buffer.compare(await readFile(join(dir, "manifest.json")), before)).toBe(0);
	});

	test("writing through a symlink inside the bundle is refused", async () => {
		// THIS TEST VALIDATES A HARD REQUIREMENT (EVL-001.2.3)
		// YOU MUST NOT MODIFY THIS TEST UNLESS THE REQUIREMENT CHANGES
		const { manifest } = await fixture();
		const root = await tempRoot();
		const dir = join(root, manifest.run.id);
		await createBundle(dir, { manifest: { ...manifest, run: { ...manifest.run, status: "running", ended_at: null }, results: [] }, files: { "prompts/scan.txt": (await fixture()).files["prompts/scan.txt"]! } });
		await mkdir(join(root, "elsewhere"));
		await symlink(join(root, "elsewhere"), join(dir, "cases"));
		await expect(addArtifacts(dir, { "cases/declined/input.json": {} })).rejects.toThrow("symbolic link");
		expect(await readdir(join(root, "elsewhere"))).toEqual([]);
	});
});

describe("comparison", () => {
	let baseline: Promise<Manifest> | undefined;
	/** The baseline is written and valid; the candidate is a changed copy of it. */
	async function pair(change: (m: Manifest) => void) {
		baseline ??= written(() => {}, "base-run").then((w) => w.manifest);
		const base = await baseline;
		const cand = structuredClone(base);
		cand.run.id = "candidate-run";
		change(cand);
		return compareManifests(base, cand);
	}

	test("different dataset digests or scorer versions are not comparable", async () => {
		// THIS TEST VALIDATES A HARD REQUIREMENT (EVL-001.7.1)
		// YOU MUST NOT MODIFY THIS TEST UNLESS THE REQUIREMENT CHANGES
		const dataset = await pair((m) => (m.dataset.digest = "1".repeat(64)));
		expect(dataset.comparable).toBe(false);
		expect(dataset.cases).toEqual([]);
		const scorer = await pair((m) => (m.scorers[0]!.version = "2"));
		expect(scorer.comparable).toBe(false);
		expect(scorer.reasons[0]).toContain("scorers differ");
	});

	test("different modes, subjects, or case lists are not comparable", async () => {
		// THIS TEST VALIDATES A HARD REQUIREMENT (EVL-001.7.1)
		// YOU MUST NOT MODIFY THIS TEST UNLESS THE REQUIREMENT CHANGES
		const mode = await pair((m) => {
			m.mode = "real-model";
			m.model = { kind: "provider", provider: "openai", id: "gpt-x", configuration: {}, recordings_digest: null };
		});
		expect(mode).toMatchObject({ comparable: false, cases: [], tally: { not_compared: 0, fixed: 0, regressed: 0 } });
		expect(mode.reasons[0]).toStartWith("mode differs");
		expect((await pair((m) => (m.subject.id = "other-workflow"))).reasons[0]).toStartWith("subject differs");
		expect((await pair((m) => (m.subject.source.repository = "ai-outfitter/other"))).comparable).toBe(false);
		const reordered = await pair((m) => m.dataset.cases.reverse());
		expect(reordered.reasons).toEqual(['dataset.cases differs: ["declined","partial-sources"] vs ["partial-sources","declined"]']);
	});

	test("source paths are reported as provenance", async () => {
		const report = await pair((m) => m.subject.source.paths.push("catalog/workflows/forerunner-setup/evals/cases/1"));
		expect(report.undeclared).toEqual(["subject.source.paths"]);
	});

	test("declared and actual changes are both reported, and extra changes are flagged", async () => {
		// THIS TEST VALIDATES A HARD REQUIREMENT (EVL-001.7.2, EVL-001.7.3)
		// YOU MUST NOT MODIFY THIS TEST UNLESS THE REQUIREMENT CHANGES
		const clean = await pair((m) => {
			m.model.configuration = { maxOutputTokens: 8000 };
			m.change = { variable: "model.configuration", baseline: "base-run", description: "more output tokens" };
		});
		expect(clean.changes.map((c) => c.field)).toEqual(["model.configuration"]);
		expect(clean.mismatch).toBe(false);

		const confounded = await pair((m) => {
			m.model.configuration = { maxOutputTokens: 8000 };
			m.subject.source.commit = "a".repeat(40);
			m.change = { variable: "model.configuration", baseline: "base-run", description: "more output tokens" };
		});
		expect(confounded.changes.map((c) => c.field)).toEqual(["subject.source.commit", "model.configuration"]);
		expect(confounded.undeclared).toEqual(["subject.source.commit"]);
		expect(confounded.mismatch).toBe(true);
	});

	test("a declared prompt change covers the commit but not the definition", async () => {
		// THIS TEST VALIDATES A HARD REQUIREMENT (EVL-001.7.3, EVL-001.1.8)
		// YOU MUST NOT MODIFY THIS TEST UNLESS THE REQUIREMENT CHANGES
		const declare = (m: Manifest) => {
			m.prompts[0]!.digest = "9".repeat(64);
			m.subject.source.commit = "a".repeat(40);
			m.change = { variable: "prompts", baseline: "base-run", description: "stricter consent wording" };
		};
		const clean = await pair(declare);
		expect(clean.changes.map((c) => c.field)).toEqual(["subject.source.commit", "prompts"]);
		expect(clean.mismatch).toBe(false);

		// The definition digest excludes prompt text, so moving it means something else changed too.
		const confounded = await pair((m) => {
			declare(m);
			m.subject.definition_digest = "b".repeat(64);
		});
		expect(confounded.undeclared).toEqual(["subject.definition_digest"]);
		expect(confounded.mismatch).toBe(true);
	});

	test("errors and missing results are never passes or regressions", async () => {
		// THIS TEST VALIDATES A HARD REQUIREMENT (EVL-001.7.4)
		// YOU MUST NOT MODIFY THIS TEST UNLESS THE REQUIREMENT CHANGES
		const report = await pair((m) => {
			m.run.status = "failed";
			m.results[0]!.status = "error";
			m.results[0]!.checks[0] = { scorer: "consent-grants-no-access", status: "error", reason: "timeout" };
			m.results.pop();
		});
		expect(report.comparable).toBe(true);
		expect(report.cases.map((c) => c.transition)).toEqual(["not-compared", "not-compared"]);
		expect(report.tally).toEqual({ unchanged_pass: 0, unchanged_fail: 0, fixed: 0, regressed: 0, not_compared: 2 });
		expect(report.notes).toContain("candidate run is failed");
	});

	test("pass/fail transitions are tallied", async () => {
		const report = await pair((m) => {
			m.results[1]!.status = "pass";
			m.results[1]!.checks[0]!.status = "pass";
		});
		expect(report.tally).toMatchObject({ unchanged_pass: 1, fixed: 1, regressed: 0 });
	});
});

describe("portability", () => {
	test("the server and bundles share one canonicalization", () => {
		// THIS TEST VALIDATES A HARD REQUIREMENT (EVL-001.1.2)
		// YOU MUST NOT MODIFY THIS TEST UNLESS THE REQUIREMENT CHANGES
		expect(serverCanonicalize).toBe(canonicalize);
	});

	test("the pure module imports no runtime-specific APIs", async () => {
		// THIS TEST VALIDATES A HARD REQUIREMENT (EVL-001.8.2)
		// YOU MUST NOT MODIFY THIS TEST UNLESS THE REQUIREMENT CHANGES
		for (const file of ["index.ts", "types.ts", "canonical.ts", "validate.ts", "compare.ts", "publication.ts", "report.ts"]) {
			const source = await readFile(join(import.meta.dir, file), "utf8");
			expect(source).not.toMatch(/from\s+["'](?:bun|bun:|node:)/);
			expect(source).not.toMatch(/\bBun\.|\bprocess\.|\bBuffer\b|\brequire\(/);
		}
	});

	// Node 22.18+ runs .ts by stripping types, which is also what the webapp's
	// tsx loader needs: erasable syntax only, no Bun globals.
	const node = spawnSync("node", ["--version"], { encoding: "utf8" });
	const [major = 0, minor = 0] = (node.stdout ?? "").replace("v", "").split(".").map(Number);
	const nodeStrips = node.status === 0 && (major > 22 || (major === 22 && minor >= 18));

	test.skipIf(!nodeStrips)("the package writes, validates, and compares under Node", async () => {
		// THIS TEST VALIDATES A HARD REQUIREMENT (EVL-001.8.2)
		// YOU MUST NOT MODIFY THIS TEST UNLESS THE REQUIREMENT CHANGES
		const root = await tempRoot();
		const script = `
			const n = await import(${JSON.stringify(join(import.meta.dir, "node.ts"))});
			const e = await import(${JSON.stringify(join(import.meta.dir, "index.ts"))});
			const f = await import(${JSON.stringify(join(import.meta.dir, "test-fixture.ts"))});
			const { manifest, files } = await f.fixture("node-run");
			const written = await n.writeBundle(${JSON.stringify(join(root, "node-run"))}, { manifest, files });
			const report = await n.validateBundle(${JSON.stringify(join(root, "node-run"))});
			const cmp = e.compareManifests(written, written);
			console.log(JSON.stringify({ valid: report.valid, comparable: cmp.comparable, digest: await e.canonicalDigest(written) }));
		`;
		const run = spawnSync("node", ["--no-warnings", "--input-type=module", "-e", script], { encoding: "utf8", timeout: 60_000 });
		expect(run.stderr).toBe("");
		const out = JSON.parse(run.stdout);
		expect(out).toMatchObject({ valid: true, comparable: true });
		// Node's Web Crypto and the bundle written there agree with Bun.
		expect(out.digest).toBe(await canonicalDigest(await readManifest(join(root, "node-run"))));
	}, 60_000);
});

describe("cli", () => {
	const cli = (...args: string[]) => spawnSync("bun", [join(import.meta.dir, "cli.ts"), ...args], { encoding: "utf8" });

	test("exit codes: valid 0, invalid 1, incomparable 1, usage 2", async () => {
		const base = await written(() => {}, "base-run");
		const cand = await written((m) => (m.dataset.digest = "1".repeat(64)), "candidate-run");
		expect(cli("validate", base.dir).status).toBe(0);
		expect(cli("summary", base.dir).stdout).toContain("RECORDED");
		const compare = cli("compare", base.dir, cand.dir);
		expect(compare.status).toBe(1);
		expect(compare.stdout).toContain("NOT COMPARABLE");
		await writeFile(join(base.dir, "stray.txt"), "x");
		const invalid = cli("validate", base.dir, "--json");
		expect(invalid.status).toBe(1);
		expect(JSON.parse(invalid.stdout)[0].issues).toEqual([{ file: "stray.txt", message: "not listed in manifest.artifacts" }]);
		expect(cli("nonsense").status).toBe(2);
		expect(cli("validate", base.dir, "--publicaton").status).toBe(2);
		expect(cli("compare", base.dir, cand.dir, "--publication").status).toBe(2);
	});
});

