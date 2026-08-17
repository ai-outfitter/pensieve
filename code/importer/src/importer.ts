import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { HarnessAdapter } from "./harness.ts";
import { findTranscripts, inspectTranscript, type TranscriptInspection } from "./transcript.ts";

// Concurrency is fixed rather than exposed. Every value would be a supported
// configuration nobody tests, and the interleaving it changes is exactly where
// the duplicate-record and abort semantics live.
const CONCURRENCY = 4;

export interface ImportOptions {
	sink: string;
	token: string;
	identity: string;
	/** Adapters in detection order; a file belongs to the first that claims it. */
	adapters: HarnessAdapter[];
	/** Roots to scan. Defaults to each adapter's own default source. */
	sources?: string[];
	dryRun: boolean;
	since?: Date;
	statePath: string;
	maxBytes?: number;
	now?: () => Date;
}

/**
 * An authentication or authorization failure is fatal for the whole run.
 *
 * A payload upload only needs write permission; the identity check happens when
 * the RECORD is ingested (SRV-001.2.4). So a token and an --identity that do not
 * agree upload every transcript in the tree into COMPLIANCE-locked storage and
 * then have every record refused. Those bytes cannot be deleted and nothing
 * references them. Treating the first 401/403 as fatal is what bounds that to
 * one file.
 */
export class FatalImportError extends Error {}

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
	upload(path: string, expectedDigest: string, size: number, mediaType: string): Promise<PayloadReference>;
	postRecord(record: Record<string, unknown>): Promise<RecordReceipt>;
}

interface ImportState {
	version: 1;
	payloads: Record<
		string,
		{
			imported_at: string;
			imported_from: string;
			/** Which adapter claimed the file, so the checkpoint can answer "which Codex sessions are imported". */
			harness?: string;
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

/**
 * Above this size the payload goes to the object store through a presigned
 * PUT instead of through the sink's request body. The sink sits behind an
 * ingress with a bounded body size, and the largest local rollouts exceed it;
 * the threshold stays under that bound so a direct POST never hits it.
 */
export const PRESIGN_OVER_BYTES = 32 * 1024 * 1024;

export class HttpImportSink implements ImportSink {
	private readonly base: string;

	constructor(
		sink: string,
		private readonly token: string,
		private readonly presignOverBytes = PRESIGN_OVER_BYTES,
	) {
		this.base = sink.replace(/\/$/, "");
	}

	async upload(path: string, expectedDigest: string, size: number, mediaType: string): Promise<PayloadReference> {
		if (size > this.presignOverBytes) return this.uploadPresigned(path, expectedDigest, size, mediaType);
		const response = await fetch(`${this.base}/v0/payloads`, {
			method: "POST",
			headers: { authorization: `Bearer ${this.token}`, "content-type": mediaType },
			body: Bun.file(path),
		});
		if (response.status === 401 || response.status === 403) {
			throw new FatalImportError(`payload refused: ${response.status} ${await response.text()}`);
		}
		if (!response.ok) throw new Error(`payload rejected: ${response.status} ${await response.text()}`);
		const result = (await response.json()) as { digest?: unknown; locator?: unknown };
		if (result.digest !== expectedDigest) {
			throw new Error(`sink returned payload digest ${String(result.digest)}, expected ${expectedDigest}`);
		}
		if (typeof result.locator !== "string") throw new Error("sink returned no payload locator");
		return { digest: expectedDigest, media_type: mediaType, size, locator: result.locator };
	}

	/**
	 * Presign → PUT → seal. The store verifies the digest itself: the presigned
	 * request pins `x-amz-checksum-sha256`, so a file that changed between
	 * hashing and upload is refused by the store, and the seal step re-checks
	 * the stored checksum and the COMPLIANCE lock before vouching for it.
	 */
	private async uploadPresigned(
		path: string,
		expectedDigest: string,
		size: number,
		mediaType: string,
	): Promise<PayloadReference> {
		const presign = await fetch(`${this.base}/v0/payloads/presign`, {
			method: "POST",
			headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
			body: JSON.stringify({ digest: expectedDigest, size, content_type: mediaType }),
		});
		if (presign.status === 401 || presign.status === 403) {
			throw new FatalImportError(`presign refused: ${presign.status} ${await presign.text()}`);
		}
		if (presign.status === 501) {
			throw new Error(
				`presign rejected: 501 ${await presign.text()}. ` +
					"The sink's store cannot presign; files this large need an S3-backed sink.",
			);
		}
		if (!presign.ok) throw new Error(`presign rejected: ${presign.status} ${await presign.text()}`);
		const grant = (await presign.json()) as { url?: unknown; headers?: unknown };
		if (typeof grant.url !== "string" || typeof grant.headers !== "object" || grant.headers === null) {
			throw new Error("sink returned a malformed presign grant");
		}

		const put = await fetch(grant.url, {
			method: "PUT",
			headers: grant.headers as Record<string, string>,
			body: Bun.file(path),
		});
		if (!put.ok) throw new Error(`presigned upload rejected: ${put.status} ${await put.text()}`);

		const seal = await fetch(`${this.base}/v0/payloads/${expectedDigest}/seal`, {
			method: "POST",
			headers: { authorization: `Bearer ${this.token}` },
		});
		if (seal.status === 401 || seal.status === 403) {
			throw new FatalImportError(`seal refused: ${seal.status} ${await seal.text()}`);
		}
		if (!seal.ok) throw new Error(`seal rejected: ${seal.status} ${await seal.text()}`);
		const sealed = (await seal.json()) as { digest?: unknown; statement?: { locator?: unknown } };
		if (sealed.digest !== expectedDigest) {
			throw new Error(`sink sealed payload digest ${String(sealed.digest)}, expected ${expectedDigest}`);
		}
		const locator = sealed.statement?.locator;
		if (typeof locator !== "string") throw new Error("seal statement carries no payload locator");
		return { digest: expectedDigest, media_type: mediaType, size, locator };
	}

	async postRecord(record: Record<string, unknown>): Promise<RecordReceipt> {
		const response = await fetch(`${this.base}/v0/records`, {
			method: "POST",
			headers: { authorization: `Bearer ${this.token}`, "content-type": "application/json" },
			body: JSON.stringify(record),
		});
		if (response.status === 401 || response.status === 403) {
			throw new FatalImportError(
				`record refused: ${response.status} ${await response.text()}. ` +
					"The payload is already stored and cannot be removed. Check that --identity " +
					"names the principal --token authenticates.",
			);
		}
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
		case "too-large": return "exceeds the import sanity cap";
		case "unknown-harness": return "no harness adapter recognizes this file";
		case "missing-run":
			return item.malformedLines > 0
				? `no run identity (${item.malformedLines} malformed line${item.malformedLines === 1 ? "" : "s"} ignored)`
				: "no run identity";
		case undefined: return undefined;
	}
}

function recordFor(
	item: TranscriptInspection,
	adapter: HarnessAdapter,
	payload: PayloadReference,
	options: ImportOptions,
	importedAt: string,
	supersedes: string[] = [],
) {
	return {
		// The adapter speaks FIRST and the engine's invariants land after it,
		// so no adapter — present or future — can clobber provenance,
		// observed, the capture report, or supersedes. A wrong value in any
		// of those is uncorrectable once the record is stored.
		...adapter.toRecordFields(item.metadata),
		// A transcript that grew is a correction, and a correction must name what
		// it replaces rather than silently sit beside it. SRV-001.3.5.
		...(supersedes.length > 0 ? { supersedes } : {}),
		kind: "transcript",
		attempt: 1,
		identity: options.identity,
		environment: "workstation",
		policy_digest: "unattested:imported",
		created_at: importedAt,
		provenance: "imported",
		observed: false,
		imported_from: item.path,
		imported_at: importedAt,
		// A reconstructed transcript satisfies no live capture class: not
		// model-exchange (CLC-001.7.2), and not the session or tool events a
		// collector would have observed. The gaps are declared, never silent.
		// CLC-001.4.4.
		capture: {
			profile: "reconstructed",
			required: [],
			captured: ["transcript"],
			gaps: adapter.unsupported,
		},
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
	// A default root that does not exist is a harness that is not installed on
	// this machine, not an error — but an explicitly passed --source that does
	// not exist is a typo and must fail loudly.
	const explicit = options.sources !== undefined;
	const sources = options.sources ?? options.adapters.map((adapter) => adapter.defaultSource(process.env));
	const paths = (
		await Promise.all(
			sources.map(async (source) => {
				try {
					return await findTranscripts(source);
				} catch (error) {
					if (!explicit && (error as NodeJS.ErrnoException).code === "ENOENT") return [];
					throw error;
				}
			}),
		)
	).flat();
	const state = await loadState(options.statePath);
	const adapterByName = new Map(options.adapters.map((adapter) => [adapter.harness, adapter]));

	// A file that cannot be read must not end the run. Scanning a live
	// ~/.claude/projects races the harness rotating its own files, so one ENOENT
	// or EACCES would otherwise reject out of Promise.all and discard every
	// remaining result.
	const inspections = await mapConcurrent(paths, CONCURRENCY, async (path) => {
		try {
			return await inspectTranscript(path, options.adapters, options.maxBytes);
		} catch (error) {
			return { path, error: error instanceof Error ? error.message : String(error) } as const;
		}
	});

	// Which digests each source path has already been imported at. A Claude Code
	// transcript is append-only, so a session that was live during an earlier run
	// comes back with a different digest and the digest-keyed skip does not fire.
	const priorByPath = new Map<string, Array<{ digest: string; record_digest?: string }>>();
	for (const [digest, entry] of Object.entries(state.payloads)) {
		if (entry.status !== "complete") continue;
		const list = priorByPath.get(entry.imported_from) ?? [];
		list.push({ digest, record_digest: entry.record_digest });
		priorByPath.set(entry.imported_from, list);
	}

	const seen = new Set<string>();
	let completed = 0;
	let stateWrite = Promise.resolve();
	let fatal: FatalImportError | undefined;

	const decisions = await mapConcurrent(inspections, CONCURRENCY, async (item) => {
		let decision: ImportDecision;
		if ("error" in item) {
			decision = { kind: "failed", path: item.path, reason: `cannot read transcript: ${item.error}` };
			completed += 1;
			onDecision?.(decision, completed, inspections.length);
			return decision;
		}
		const reason = skipReason(item);
		const adapter = item.harness !== undefined ? adapterByName.get(item.harness) : undefined;
		// Grew-since-import handling applies only to a harness that appends to a
		// live transcript in place. For one that writes once or rotates, a new
		// digest at an old path is a different file, not a correction.
		const prior = adapter?.appendOnly ? (priorByPath.get(item.path) ?? []) : [];
		if (fatal) {
			decision = { kind: "skipped", path: item.path, reason: "run aborted", digest: item.digest };
		} else if (reason) {
			decision = { kind: "skipped", path: item.path, reason, digest: item.digest };
		} else if (options.since && item.modifiedAt < options.since) {
			decision = { kind: "skipped", path: item.path, reason: "older than --since", digest: item.digest };
		} else if (item.digest && state.payloads[item.digest]?.status !== "pending" && state.payloads[item.digest]) {
			decision = { kind: "skipped", path: item.path, reason: "payload digest already imported", digest: item.digest };
		} else if (item.digest && seen.has(item.digest)) {
			decision = { kind: "skipped", path: item.path, reason: "duplicate payload digest in source tree", digest: item.digest };
		} else if (prior.length > 0 && !prior.some((entry) => entry.record_digest)) {
			// The source grew since it was imported, and the record that covers the
			// earlier bytes was never retained, so a new record could not name what
			// it supersedes. Writing one anyway puts two unlinked transcripts for
			// the same run into a store that cannot correct either. SRV-001.3.5.
			decision = {
				kind: "skipped",
				path: item.path,
				reason: "source grew since import and the prior record digest is unknown",
				digest: item.digest,
			};
		} else {
			if (!item.digest) throw new Error("eligible transcript has no digest");
			seen.add(item.digest);
			if (options.dryRun) {
				decision = { kind: "would-import", path: item.path, reason: "eligible", digest: item.digest };
			} else {
				try {
					const importedAt = state.payloads[item.digest]?.imported_at ?? (options.now ?? (() => new Date()))().toISOString();
					state.payloads[item.digest] = { imported_at: importedAt, imported_from: item.path, harness: item.harness, status: "pending" };
					stateWrite = stateWrite.then(() => saveState(options.statePath, state));
					await stateWrite;
					if (!adapter) throw new Error("eligible transcript has no adapter");
					const payload = await sink.upload(item.path, item.digest, item.size, adapter.mediaType);
					const supersedes = prior.flatMap((entry) => (entry.record_digest ? [entry.record_digest] : []));
					const receipt = await sink.postRecord(recordFor(item, adapter, payload, options, importedAt, supersedes));
					state.payloads[item.digest] = {
						imported_at: importedAt,
						imported_from: item.path,
						harness: item.harness,
						status: "complete",
						record_digest: receipt.digest,
					};
					stateWrite = stateWrite.then(() => saveState(options.statePath, state));
					await stateWrite;
					decision = { kind: "imported", path: item.path, reason: "payload and record accepted", digest: item.digest };
				} catch (error) {
					if (error instanceof FatalImportError) fatal ??= error;
					decision = { kind: "failed", path: item.path, reason: error instanceof Error ? error.message : String(error), digest: item.digest };
				}
			}
		}
		completed += 1;
		onDecision?.(decision, completed, inspections.length);
		return decision;
	});

	if (fatal) throw fatal;

	// Only skips aggregate. A failure reason is a free-text error message, so
	// counting those turns the summary into a verbatim reprint of the per-file
	// log — worse the more files fail, which is when the summary matters most.
	const reasons: Record<string, number> = {};
	for (const decision of decisions) {
		if (decision.kind !== "skipped") continue;
		reasons[decision.reason] = (reasons[decision.reason] ?? 0) + 1;
	}
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
