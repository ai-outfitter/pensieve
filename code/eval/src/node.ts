/**
 * @pensieve/eval — filesystem half. Node APIs only (`node:fs`, `node:path`),
 * so it runs under Node and Bun but not Workers.
 *
 * Writing is append-only and has exactly three steps (EVL-001.4):
 *   createBundle   → a new directory with a validated `running` manifest
 *   addArtifacts   → new files while the run is running
 *   finalizeBundle → once: final status, results, gaps (and last files)
 * One process writes a bundle; concurrent writers are not supported.
 */
import { lstat, mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { canonicalize, sha256Hex } from "./canonical.ts";
import { summarize } from "./report.ts";
import { MANIFEST_FILE, RECEIPT_FILE, type Artifact, type Issue, type Manifest, type RunStatus, type ValidationReport } from "./types.ts";
import { isSafePath, validateBundleFiles, validateManifest, type BundleFiles } from "./validate.ts";

/** File contents: bytes and strings are written as given; anything else as canonical JSON. */
export type FileContent = Uint8Array | string | object;
export type Files = Record<string, FileContent>;

/** A manifest as a writer supplies it: artifacts are computed, summary is derived. */
export type ManifestInput = Omit<Manifest, "artifacts" | "summary">;

/** The only fields a run may set when it ends. Identity, subject, model, and prompts are fixed at creation. */
export interface Finalization {
	status: Exclude<RunStatus, "running">;
	ended_at: string | null;
	results: Manifest["results"];
	gaps: Manifest["gaps"];
	files?: Files;
}

const ENCODER = new TextEncoder();
const MEDIA_TYPES: Record<string, string> = { json: "application/json", md: "text/markdown", txt: "text/plain" };
const mediaType = (path: string) => MEDIA_TYPES[path.split(".").pop() ?? ""] ?? "application/octet-stream";

function encode(content: FileContent): Uint8Array {
	if (content instanceof Uint8Array) return content;
	return ENCODER.encode(typeof content === "string" ? content : canonicalize(content));
}

const exists = (path: string) => lstat(path).then((s) => s, () => null);

/** Refuse a path that exists, or that would be written through a symlink inside the bundle. EVL-001.2.3. */
async function checkWritable(dir: string, path: string): Promise<void> {
	const parts = path.split("/");
	for (let i = 1; i <= parts.length; i++) {
		const stat = await exists(join(dir, ...parts.slice(0, i)));
		if (!stat) return;
		if (stat.isSymbolicLink()) throw new Error(`refusing to write ${path}: ${parts.slice(0, i).join("/")} is a symbolic link`);
		if (i === parts.length) throw new Error(`refusing to overwrite ${path}; artifacts are never rewritten`);
	}
}

async function prepare(dir: string, files: Files): Promise<{ bytes: Map<string, Uint8Array>; artifacts: Artifact[] }> {
	const bytes = new Map<string, Uint8Array>();
	const artifacts: Artifact[] = [];
	for (const [path, content] of Object.entries(files)) {
		if (!isSafePath(path) || path === MANIFEST_FILE || path === RECEIPT_FILE) throw new Error(`refusing artifact path ${path}`);
		await checkWritable(dir, path);
		const b = encode(content);
		bytes.set(path, b);
		artifacts.push({ path, digest: await sha256Hex(b), size: b.byteLength, media_type: mediaType(path) });
	}
	return { bytes, artifacts };
}

function assertValid(manifest: Manifest): void {
	const issues = validateManifest(manifest);
	if (issues.length > 0) throw new Error(`invalid manifest:\n${issues.map((i) => `  ${i.field ?? ""}: ${i.message}`).join("\n")}`);
}

/** Validate, then write the manifest atomically, then the new artifacts with `wx`. */
async function commit(dir: string, manifest: Manifest, bytes: Map<string, Uint8Array>): Promise<Manifest> {
	manifest.artifacts.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	assertValid(manifest);
	const tmp = join(dir, `.${MANIFEST_FILE}.${crypto.randomUUID()}.tmp`);
	try {
		await writeFile(tmp, canonicalize(manifest), { flag: "wx" });
		await rename(tmp, join(dir, MANIFEST_FILE));
	} finally {
		await unlink(tmp).catch(() => {});
	}
	for (const [path, b] of bytes) {
		await mkdir(dirname(join(dir, path)), { recursive: true });
		await writeFile(join(dir, path), b, { flag: "wx" });
	}
	return manifest;
}

async function running(dir: string): Promise<Manifest> {
	const current = await readManifest(dir);
	if (current.run.status !== "running") throw new Error(`bundle ${dir} is ${current.run.status}; only a running bundle can change`);
	return current;
}

/**
 * Create a new bundle directory named by the run id, holding a validated
 * `running` manifest and the given files. Refuses an existing directory, so
 * earlier, failed, and interrupted runs are never overwritten. EVL-001.4.5.
 */
export async function createBundle(dir: string, input: { manifest: ManifestInput; files?: Files }): Promise<Manifest> {
	const { manifest } = input;
	if (basename(dir) !== manifest.run.id) throw new Error(`bundle directory must be named by its run id ${manifest.run.id}`);
	if (manifest.run.status !== "running" || manifest.results.length > 0) {
		throw new Error("a bundle is created running with no results; finalizeBundle sets them");
	}
	if (await exists(dir)) throw new Error(`bundle ${dir} already exists; a rerun needs a new run id`);
	const { bytes, artifacts } = await prepare(dir, input.files ?? {});
	const created: Manifest = { ...manifest, summary: summarize([]), artifacts };
	assertValid(created); // before the directory exists, so a bad manifest leaves nothing behind
	await mkdir(dirname(dir), { recursive: true });
	try {
		await mkdir(dir);
	} catch (error) {
		if ((error as { code?: string }).code === "EEXIST") throw new Error(`bundle ${dir} already exists; a rerun needs a new run id`);
		throw error;
	}
	return commit(dir, created, bytes);
}

/** Add new files to a running bundle. Existing artifacts are never touched. EVL-001.4.6. */
export async function addArtifacts(dir: string, files: Files): Promise<Manifest> {
	const current = await running(dir);
	const { bytes, artifacts } = await prepare(dir, files);
	return commit(dir, { ...current, artifacts: [...current.artifacts, ...artifacts] }, bytes);
}

/** End a running bundle, once. Only status, end time, results, gaps, and new files may be set. EVL-001.4.6. */
export async function finalizeBundle(dir: string, end: Finalization): Promise<Manifest> {
	const current = await running(dir);
	if ((end.status as string) === "running") throw new Error("finalize needs a final status");
	const { bytes, artifacts } = await prepare(dir, end.files ?? {});
	return commit(dir, {
		...current,
		run: { ...current.run, status: end.status, ended_at: end.ended_at },
		results: end.results,
		gaps: end.gaps,
		summary: summarize(end.results),
		artifacts: [...current.artifacts, ...artifacts],
	}, bytes);
}

/** Create and finalize in one call, for a run whose results are already known. */
export async function writeBundle(dir: string, input: { manifest: ManifestInput; files: Files }): Promise<Manifest> {
	const { run, results, gaps } = input.manifest;
	if (run.status === "running") return createBundle(dir, input);
	await createBundle(dir, { manifest: { ...input.manifest, run: { ...run, status: "running", ended_at: null }, results: [] }, files: input.files });
	return finalizeBundle(dir, { status: run.status, ended_at: run.ended_at, results, gaps });
}

export async function readManifest(dir: string): Promise<Manifest> {
	return JSON.parse(await readFile(join(dir, MANIFEST_FILE), "utf8"));
}

/** Read every file under `dir`. Symlinks and special files are reported, never followed. EVL-001.2.3. */
export async function readBundle(dir: string): Promise<BundleFiles> {
	const files = new Map<string, Uint8Array>();
	const issues: Issue[] = [];
	async function walk(rel: string): Promise<void> {
		for (const entry of await readdir(join(dir, rel), { withFileTypes: true })) {
			const path = rel ? `${rel}/${entry.name}` : entry.name;
			if (entry.isDirectory()) await walk(path);
			else if (entry.isFile()) files.set(path, new Uint8Array(await readFile(join(dir, path))));
			else issues.push({ file: path, message: entry.isSymbolicLink() ? "is a symbolic link; bundles hold plain files only" : "is not a regular file" });
		}
	}
	await walk("");
	return { files, issues };
}

/** Validate a bundle directory offline. EVL-001.1–6. */
export async function validateBundle(dir: string, options: { publication?: boolean } = {}): Promise<ValidationReport> {
	const stat = await exists(dir);
	if (!stat?.isDirectory()) {
		return { valid: false, run: null, mode: null, status: null, issues: [{ file: dir, message: "is not a bundle directory" }] };
	}
	const report = await validateBundleFiles(await readBundle(dir), options);
	if (report.run !== null && report.run !== basename(dir)) {
		report.issues.push({ file: MANIFEST_FILE, field: "run.id", message: `is ${report.run} but the bundle directory is ${basename(dir)}` });
		report.valid = false;
	}
	return report;
}
