import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { findTranscripts, inspectTranscript, type TranscriptInspection } from "./transcript.ts";

const MEDIA_TYPE = "application/x-ndjson";

export interface ImportOptions {
	sink: string;
	token: string;
	identity: string;
	source: string;
	dryRun: boolean;
	since?: Date;
	project?: string;
	concurrency: number;
	statePath: string;
	maxBytes?: number;
	now?: () => Date;
}

export type DecisionKind = "imported" | "would-import" | "skipped" | "failed";

export interface ImportDecision {
	kind: DecisionKind;
	path: string;
	reason: string;
	digest?: string;
}

export interface ImportSummary {
	discovered: number;
	imported: number;
	wouldImport: number;
	skipped: number;
	failed: number;
	reasons: Record<string, number>;
	decisions: ImportDecision[];
}

interface PayloadReference {
	digest: string;
	media_type: string;
	size: number;
	locator: string;
}

/** What the sink returns when it accepts a record. SRV-001.5.5. */
export interface RecordReceipt {
	digest: string;
}

export interface ImportSink {
	upload(path: string, expectedDigest: string, size: number): Promise<PayloadReference>;
	postRecord(record: Record<string, unknown>): Promise<RecordReceipt>;
}

interface ImportState {
	version: 1;
	payloads: Record<
		string,
		{
			imported_at: string;
			imported_from: string;
			status?: "pending" | "complete";
			/**
			 * The record digest the sink returned. `GET /v0/records/<digest>` is
			 * keyed on it, so discarding it leaves the record unaddressable —
			 * the payload is content-addressed and findable, the record is not.
			 * Absent on entries written before this was retained; there is no
			 * backfill, because the digest is only knowable at ingest.
			 */
			record_digest?: string;
		}
	>;
}

export class HttpImportSink implements ImportSink {
	private readonly base: string;

	constructor(sink: string, private readonly token: string) {
		this.base = sink.replace(/\/$/, "");
	}

	async upload(path: string, expectedDigest: string, size: number): Promise<PayloadReference> {
		const response = await fetch(`${this.base}/v0/payloads`, {
			method: "POST",
			headers: { authorization: `Bearer ${this.token}`, "content-type": MEDIA_TYPE },
			body: Bun.file(path),
		});
		if (!response.ok) throw new Error(`payload rejected: ${response.status} ${await response.text()}`);
		const result = (await response.json()) as { digest?: unknown; locator?: unknown };
		if (result.digest !== expectedDigest) {
			throw new Error(`sink returned payload digest ${String(result.digest)}, expected ${expectedDigest}`);
		}
		if (typeof result.locator !== "string") throw new Error("sink returned no payload locator");
		return { digest: expectedDigest, media_type: MEDIA_TYPE, size, locator: result.locator };
	}

	async postRecord(record: Record<string, unknown>): Promise<RecordReceipt> {
		const response = await fetch(`${this.base}/v0/records`, {
			method: "POST",
			headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
			body: JSON.stringify(record),
		});
		if (!response.ok) throw new Error(`record rejected: ${response.status} ${await response.text()}`);
		const result = (await response.json()) as { digest?: unknown };
		if (typeof result.digest !== "string" || !/^[0-9a-f]{64}$/.test(result.digest)) {
			throw new Error("sink accepted the record but returned no record digest");
		}
		return { digest: result.digest };
	}
}

async function loadState(path: string): Promise<ImportState> {
	try {
		const state = JSON.parse(await readFile(path, "utf8")) as Partial<ImportState>;
		if (state.version !== 1 || typeof state.payloads !== "object" || state.payloads === null) {
			throw new Error("unsupported checkpoint format");
		}
		return state as ImportState;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, payloads: {} };
		throw new Error(`cannot read importer checkpoint ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

async function saveState(path: string, state: ImportState): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.${process.pid}.tmp`;
	await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
	await rename(temporary, path);
}

function skipReason(item: TranscriptInspection): string | undefined {
	switch (item.skipReason) {
		case "empty": return "empty file";
		case "too-large": return "exceeds safe upload threshold";
		case "missing-session-id":
			return item.malformedLines > 0
				? `no sessionId (${item.malformedLines} malformed line${item.malformedLines === 1 ? "" : "s"} ignored)`
				: "no sessionId";
		case undefined: return undefined;
	}
}

function recordFor(item: TranscriptInspection, payload: PayloadReference, options: ImportOptions, importedAt: string) {
	const metadata = item.metadata;
	return {
		kind: "transcript",
		run: metadata.sessionId,
		attempt: 1,
		identity: options.identity,
		environment: "workstation",
		policy_digest: "unattested:imported",
		created_at: importedAt,
		harness: "claude-code",
		harness_version: metadata.version ?? "unknown",
		cwd: metadata.cwd,
		git_branch: metadata.gitBranch,
		provenance: "imported",
		observed: false,
		imported_from: item.path,
		imported_at: importedAt,
		payload,
	};
}

async function mapConcurrent<T, R>(items: T[], concurrency: number, work: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let cursor = 0;
	async function worker(): Promise<void> {
		while (cursor < items.length) {
			const index = cursor++;
			const item = items[index];
			if (item !== undefined) results[index] = await work(item, index);
		}
	}
	await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
	return results;
}

export async function importTranscripts(
	options: ImportOptions,
	sink: ImportSink = new HttpImportSink(options.sink, options.token),
	onDecision?: (decision: ImportDecision, completed: number, total: number) => void,
): Promise<ImportSummary> {
	const allPaths = await findTranscripts(options.source);
	const paths = allPaths.filter((path) => !options.project || path.includes(options.project));
	const state = await loadState(options.statePath);
	const inspections = await mapConcurrent(paths, options.concurrency, (path) => inspectTranscript(path, options.maxBytes));
	const seen = new Set<string>();
	let completed = 0;
	let stateWrite = Promise.resolve();

	const decisions = await mapConcurrent(inspections, options.concurrency, async (item) => {
		let decision: ImportDecision;
		const reason = skipReason(item);
		if (reason) {
			decision = { kind: "skipped", path: item.path, reason, digest: item.digest };
		} else if (options.since && item.modifiedAt < options.since) {
			decision = { kind: "skipped", path: item.path, reason: "older than --since", digest: item.digest };
		} else if (item.digest && state.payloads[item.digest]?.status !== "pending" && state.payloads[item.digest]) {
			decision = { kind: "skipped", path: item.path, reason: "payload digest already imported", digest: item.digest };
		} else if (item.digest && seen.has(item.digest)) {
			decision = { kind: "skipped", path: item.path, reason: "duplicate payload digest in source tree", digest: item.digest };
		} else {
			if (!item.digest) throw new Error("eligible transcript has no digest");
			seen.add(item.digest);
			if (options.dryRun) {
				decision = { kind: "would-import", path: item.path, reason: "eligible", digest: item.digest };
			} else {
				try {
					const importedAt = state.payloads[item.digest]?.imported_at ?? (options.now ?? (() => new Date()))().toISOString();
					state.payloads[item.digest] = { imported_at: importedAt, imported_from: item.path, status: "pending" };
					stateWrite = stateWrite.then(() => saveState(options.statePath, state));
					await stateWrite;
					const payload = await sink.upload(item.path, item.digest, item.size);
					const receipt = await sink.postRecord(recordFor(item, payload, options, importedAt));
					state.payloads[item.digest] = {
						imported_at: importedAt,
						imported_from: item.path,
						status: "complete",
						record_digest: receipt.digest,
					};
					stateWrite = stateWrite.then(() => saveState(options.statePath, state));
					await stateWrite;
					decision = { kind: "imported", path: item.path, reason: "payload and record accepted", digest: item.digest };
				} catch (error) {
					decision = { kind: "failed", path: item.path, reason: error instanceof Error ? error.message : String(error), digest: item.digest };
				}
			}
		}
		completed += 1;
		onDecision?.(decision, completed, inspections.length);
		return decision;
	});

	const reasons: Record<string, number> = {};
	for (const decision of decisions) reasons[decision.reason] = (reasons[decision.reason] ?? 0) + 1;
	return {
		discovered: paths.length,
		imported: decisions.filter((item) => item.kind === "imported").length,
		wouldImport: decisions.filter((item) => item.kind === "would-import").length,
		skipped: decisions.filter((item) => item.kind === "skipped").length,
		failed: decisions.filter((item) => item.kind === "failed").length,
		reasons,
		decisions,
	};
}
