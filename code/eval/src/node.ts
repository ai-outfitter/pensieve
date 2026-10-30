/**
 * @pensieve/eval — filesystem half. Node APIs only (`node:fs`, `node:path`),
 * so it runs under Node and Bun but not Workers.
 */
import { lstat, mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { canonicalize, sha256Hex } from "./canonical.ts";
import { summarize } from "./report.ts";
import { MANIFEST_FILE, RECEIPT_FILE, type Artifact, type Issue, type Manifest, type ValidationReport } from "./types.ts";
import { isSafePath, validateBundleFiles, type BundleFiles } from "./validate.ts";

/** File contents: bytes and strings are written as given; anything else as canonical JSON. */
export type FileContent = Uint8Array | string | object;
export type Files = Record<string, FileContent>;

export type ManifestInput = Omit<Manifest, "artifacts" | "summary"> & { summary?: Manifest["summary"] };
export type ManifestPatch = Partial<Omit<Manifest, "standard" | "artifacts" | "run">> & { run?: Partial<Manifest["run"]> };

const ENCODER = new TextEncoder();

const MEDIA_TYPES: Record<string, string> = { json: "application/json", md: "text/markdown", txt: "text/plain" };
const mediaType = (path: string) => MEDIA_TYPES[path.split(".").pop() ?? ""] ?? "application/octet-stream";

function encode(content: FileContent): Uint8Array {
	if (content instanceof Uint8Array) return content;
	return ENCODER.encode(typeof content === "string" ? content : canonicalize(content));
}

/** Write new artifacts, refusing any path that already exists. EVL-001.4.6. */
async function writeArtifacts(dir: string, files: Files): Promise<Artifact[]> {
	const artifacts: Artifact[] = [];
	for (const [path, content] of Object.entries(files)) {
		if (!isSafePath(path) || path === MANIFEST_FILE || path === RECEIPT_FILE) throw new Error(`refusing artifact path ${path}`);
		const bytes = encode(content);
		await mkdir(dirname(join(dir, path)), { recursive: true });
		await writeFile(join(dir, path), bytes, { flag: "wx" });
		artifacts.push({ path, digest: await sha256Hex(bytes), size: bytes.byteLength, media_type: mediaType(path) });
	}
	return artifacts;
}

async function writeManifest(dir: string, manifest: Manifest): Promise<void> {
	manifest.artifacts.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	const tmp = join(dir, `.${MANIFEST_FILE}.tmp`);
	await writeFile(tmp, canonicalize(manifest), { flag: "wx" });
	await rename(tmp, join(dir, MANIFEST_FILE));
}

/**
 * Create a new bundle directory named by the run id and write its artifacts
 * and manifest. Refuses an existing directory: earlier, failed, and
 * interrupted runs are never overwritten. EVL-001.4.5.
 *
 * Write with `run.status = "running"` and call `updateBundle` as the run
 * progresses, or write a finished run in one call.
 */
export async function writeBundle(dir: string, input: { manifest: ManifestInput; files: Files }): Promise<Manifest> {
	if (basename(dir) !== input.manifest.run.id) throw new Error(`bundle directory must be named by its run id ${input.manifest.run.id}`);
	await mkdir(dirname(dir), { recursive: true });
	try {
		await mkdir(dir);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`bundle ${dir} already exists; a rerun needs a new run id`);
		throw error;
	}
	const manifest: Manifest = {
		...input.manifest,
		summary: input.manifest.summary ?? summarize(input.manifest.results),
		artifacts: await writeArtifacts(dir, input.files),
	};
	await writeManifest(dir, manifest);
	return manifest;
}

/**
 * Add artifacts to a running bundle and patch its manifest — for example to
 * finalize it with `{ run: { status: "complete", ended_at }, results }`. Only
 * `manifest.json` is rewritten; existing artifacts are never touched, and a
 * bundle whose status is final cannot be updated. EVL-001.4.6.
 */
export async function updateBundle(dir: string, update: { manifest?: ManifestPatch; files?: Files }): Promise<Manifest> {
	const current = await readManifest(dir);
	if (current.run.status !== "running") throw new Error(`bundle ${dir} is ${current.run.status}; only a running bundle can be updated`);
	const { run, ...rest } = update.manifest ?? {};
	const added = await writeArtifacts(dir, update.files ?? {});
	const manifest: Manifest = { ...current, ...rest, run: { ...current.run, ...run }, artifacts: [...current.artifacts, ...added] };
	if (!rest.summary) manifest.summary = summarize(manifest.results);
	await writeManifest(dir, manifest);
	return manifest;
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
	const stat = await lstat(dir).catch(() => null);
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
