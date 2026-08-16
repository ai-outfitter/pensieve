import { canonicalize, sha256Hex } from "./canonical.ts";
import { RecordIndex, type IndexedRecord } from "./db.ts";
import type { PayloadStatement, Signer, StorageStatement } from "./identity.ts";
import {
	isAuthoritativeScope,
	sealStatus,
	validateRecord,
	type BaseRecord,
	type CommitEvidenceRecord,
	type InstallScope,
	type LandingRecord,
	type ReleaseBundleRecord,
} from "./records.ts";
import { StoreError, type Store } from "./store/types.ts";

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();
const PRESIGN_EXPIRY_SECONDS = 5 * 60;

/**
 * Which columns each kind contributes to the lookup index. A per-kind
 * projection keeps one column from meaning two things: `sha` is always the
 * commit a record covers, and a landing's new ref head has its own column.
 */
function projectForIndex(record: BaseRecord): Omit<IndexedRecord, "digest" | "kind" | "run" | "identity" | "created_at"> {
	const harness = typeof record.harness === "string" && record.harness.length > 0 ? record.harness : null;
	const payloadRef = record.payload as { digest?: unknown } | undefined;
	const derived = {
		harness,
		payload_digest: typeof payloadRef?.digest === "string" ? payloadRef.digest : null,
		provenance: typeof record.provenance === "string" ? record.provenance : null,
		// A record that does not say it was reconstructed was observed by the
		// collector that submitted it; imports declare observed: false.
		observed: record.observed === false ? 0 : 1,
	};
	const empty = { sha: null, patch_id: null, ref: null, ref_head: null, tag: null, status: null, ...derived };
	switch (record.kind) {
		case "commit-evidence": {
			const commit = record as CommitEvidenceRecord;
			return { ...empty, sha: commit.sha, patch_id: commit.patch_id, status: sealStatus(commit.capture) };
		}
		case "landing": {
			const landing = record as LandingRecord;
			return { ...empty, ref: landing.ref, ref_head: landing.after };
		}
		case "release-bundle":
			return { ...empty, tag: (record as ReleaseBundleRecord).tag };
		default:
			return empty;
	}
}

export interface Principal {
	identity: string;
	/** Read-only principals can never write evidence. CICD-001.6.4. */
	canWrite: boolean;
}

export class AuthError extends Error {
	constructor(
		message: string,
		readonly status = 401,
	) {
		super(message);
	}
}

export interface StoredRecord {
	digest: string;
	record: BaseRecord;
	statement: StorageStatement;
}

export interface CoverageEntry {
	sha: string;
	covered: boolean;
	reason: string;
	evidence?: string;
	match?: "exact" | "patch-id";
	status?: string;
}

export class Sink {
	constructor(
		private readonly store: Store,
		private readonly signer: Signer,
		private readonly index: RecordIndex,
		private readonly retentionFloorDays: number,
	) {}

	get identity() {
		return this.signer.identity;
	}

	/** A sink that cannot sign, or a store that cannot lock, is non-conforming. */
	get conforming(): boolean {
		return this.signer.identity.attested && this.store.conforming;
	}

	private retainUntil(): Date {
		return new Date(Date.now() + this.retentionFloorDays * 86_400_000);
	}

	async putPayload(bytes: Uint8Array, contentType: string): Promise<{ digest: string; locator: string }> {
		const digest = sha256Hex(bytes);
		const result = await this.store.put(`payloads/${digest.slice(0, 2)}/${digest}`, bytes, {
			contentType,
			retainUntil: this.retainUntil(),
		});
		return { digest, locator: result.locator };
	}

	async presignPayload(input: { digest: string; size: number; contentType: string }) {
		if (!this.store.presignPut) throw new StoreError("this store does not support presigned uploads", 501);
		const key = `payloads/${input.digest.slice(0, 2)}/${input.digest}`;
		return this.store.presignPut(key, {
			digest: input.digest,
			size: input.size,
			contentType: input.contentType,
			retainUntil: this.retainUntil(),
			expiresSeconds: PRESIGN_EXPIRY_SECONDS,
		});
	}

	async sealPayload(digest: string): Promise<{ digest: string; statement: PayloadStatement }> {
		if (!this.store.presignPut) throw new StoreError("this store does not support presigned uploads", 501);
		const key = `payloads/${digest.slice(0, 2)}/${digest}`;
		const head = await this.store.head(key);
		if (!head) throw new StoreError(`payload ${digest} does not exist`, 404);
		if (!head.version) throw new StoreError(`payload ${digest} has no object version`, 409);
		const expectedChecksum = Buffer.from(digest, "hex").toString("base64");
		if (head.checksumSha256 !== expectedChecksum) {
			throw new StoreError(`payload ${digest} failed checksum verification`, 409);
		}
		// Bind retention to the exact version returned by HEAD. A concurrent write
		// must not make the statement combine metadata from two object versions.
		const retention = await this.store.getRetention(key, head.version);
		if (retention?.mode !== "COMPLIANCE") {
			throw new StoreError(`payload ${digest} has no verified COMPLIANCE lock`, 409);
		}
		const unsigned: PayloadStatement = {
			content_digest: digest,
			locator: head.locator,
			object_version: head.version,
			size: head.size,
			content_type: head.contentType,
			sink: this.signer.identity.id,
			key_id: this.signer.identity.key_id,
			mechanism: this.store.kind,
			// Whatever the STORE reported, never the value placed in the presign.
			retain_until: retention.retain_until,
			lock_verified: true,
			conforming: this.conforming,
			issued_at: new Date().toISOString(),
		};
		const statement: PayloadStatement = this.signer.identity.attested
			? { ...unsigned, signature: await this.signer.sign(unsigned as unknown as Record<string, unknown>) }
			: unsigned;
		return { digest, statement };
	}

	/**
	 * Ingest. The record digest is computed first, the payload lock is applied
	 * during the write, and only then is the statement signed over what the
	 * store reported. SRV-001.3.4, SRV-001.5.3 – SRV-001.5.5.
	 */
	async ingest(input: unknown, principal: Principal): Promise<StoredRecord> {
		if (!principal.canWrite) throw new AuthError("principal may not write evidence", 403);

		const record = validateRecord(input);

		// The declared acting identity must be the authenticated principal.
		// SRV-001.2.4.
		if (record.identity !== principal.identity) {
			throw new AuthError(
				`record identity "${record.identity}" does not match authenticated principal "${principal.identity}"`,
				403,
			);
		}
		// Agent work is never attributed to a human account. SRV-001.2.5.
		if (typeof record.identity === "string" && record.identity.startsWith("user:")) {
			throw new AuthError("agent work must not be attributed to a human account", 403);
		}

		// Canonicalize once, encode once, hash once. The bytes written to the
		// store are the bytes that were digested, so a verifier that fetches the
		// object re-derives the same digest without re-canonicalizing.
		const bytes = ENCODER.encode(canonicalize(record));
		const digest = sha256Hex(bytes);
		const put = await this.store.put(`records/${digest.slice(0, 2)}/${digest}.json`, bytes, {
			contentType: "application/json",
			retainUntil: this.retainUntil(),
		});

		const unsigned: StorageStatement = {
			record_digest: digest,
			// Equal by construction: the object written to the store IS the
			// canonical serialization the digest was taken over. Both fields stay,
			// because SRV-001.5.4 binds both and a future backend that transforms
			// the payload at rest would make them differ again.
			content_digest: digest,
			locator: put.locator,
			object_version: put.version,
			sink: this.signer.identity.id,
			key_id: this.signer.identity.key_id,
			mechanism: this.store.kind,
			// Whatever the STORE reported, never the value requested.
			retain_until: put.retention?.retain_until ?? null,
			lock_verified: put.retention !== null,
			conforming: this.conforming && put.retention !== null,
			issued_at: new Date().toISOString(),
		};
		const statement: StorageStatement = this.signer.identity.attested
			? { ...unsigned, signature: await this.signer.sign(unsigned as unknown as Record<string, unknown>) }
			: unsigned;

		this.index.insert({
			digest,
			kind: record.kind,
			run: record.run,
			identity: record.identity,
			created_at: record.created_at,
			...projectForIndex(record),
		});

		if (record.kind === "landing") this.checkChain(record as LandingRecord, digest);
		if (record.install_scope && !isAuthoritativeScope(record.install_scope as InstallScope)) {
			this.index.addFinding(
				"advisory-collection",
				record.run,
				`collector install scope "${record.install_scope}" is not authoritative`,
			);
		}

		return { digest, record, statement };
	}

	/**
	 * A landing whose `before` does not match the previous record's `after` for
	 * that ref is a chain break. SRV-001.7.10.
	 */
	private checkChain(record: LandingRecord, digest: string): void {
		const previous = this.index
			.landingsForRef(record.ref)
			.filter((entry) => entry.digest !== digest)
			.at(-1);

		const broken = Boolean(previous?.ref_head && previous.ref_head !== record.before) || Boolean(record.chain_break);
		if (broken) {
			this.index.addFinding(
				"chain-break",
				record.ref,
				`expected before=${previous?.ref_head ?? "unknown"}, received before=${record.before}`,
			);
		}
		if (record.history_rewrite) {
			this.index.addFinding("history-rewrite", record.ref, `${record.before} -> ${record.after}`);
		}
		const unattested = record.landed.filter((entry) => entry.attribution === "unattested");
		if (unattested.length > 0) {
			this.index.addFinding("unattested-commit", record.ref, unattested.map((entry) => entry.sha).join(","));
		}
	}

	/**
	 * Read the record back from the STORE, not from the index. A caller holding
	 * the record and the sink key can reach the same conclusion without
	 * trusting this answer. SRV-001.10.4, SRV-001.10.5.
	 */
	async readRecord(digest: string): Promise<BaseRecord | null> {
		const bytes = await this.store.get(`records/${digest.slice(0, 2)}/${digest}.json`);
		if (!bytes) return null;
		if (sha256Hex(bytes) !== digest) throw new Error(`record ${digest} failed digest verification`);
		return JSON.parse(DECODER.decode(bytes)) as BaseRecord;
	}

	/**
	 * Payload bytes by digest, re-hashed on read: the sink refuses to serve
	 * bytes whose digest does not match the key naming them. RTR-001.1.1,
	 * RTR-001.1.2. The head precedes the get so the response can report the
	 * recorded content type and the lock the store actually holds — a reader
	 * reaches its own immutability conclusion without store credentials.
	 * RTR-001.1.3, RTR-001.1.4, RTR-001.1.5.
	 */
	async readPayload(digest: string): Promise<{
		bytes: Uint8Array;
		contentType: string;
		locator: string;
		lock: { mode: string | null; retain_until: string | null };
	} | null> {
		const key = `payloads/${digest.slice(0, 2)}/${digest}`;
		const head = await this.store.head(key);
		if (!head) return null;
		// Pin the version HEAD reported. Under Object Lock a plain DELETE may
		// still write a delete marker over a retained version, and an
		// unversioned GET would then 404 while the evidence still exists.
		const bytes = await this.store.get(key, head.version);
		if (!bytes) return null;
		if (sha256Hex(bytes) !== digest) throw new Error(`payload ${digest} failed digest verification`);
		const retention = head.version ? await this.store.getRetention(key, head.version) : null;
		return {
			bytes,
			contentType: head.contentType ?? "application/octet-stream",
			locator: head.locator,
			lock: { mode: retention?.mode ?? null, retain_until: retention?.retain_until ?? null },
		};
	}

	/** The index speaking, never evidence. RTR-001.2. */
	searchRecords(filters: Parameters<RecordIndex["search"]>[0]) {
		return this.index.search(filters);
	}

	/**
	 * The harness column is derived and additive; rows indexed before it
	 * existed hold NULL and would be invisible to a harness filter. The index
	 * is rebuilt from the records themselves — the store is the truth, the
	 * index is a map — so this is a re-derivation, not a migration of
	 * authoritative data. RTR-001 (index rebuild path).
	 */
	async backfillDerived(): Promise<{ examined: number; failed: number }> {
		let examined = 0;
		let failed = 0;
		for (const digest of this.index.unexamined()) {
			let record: BaseRecord | null = null;
			try {
				record = await this.readRecord(digest);
			} catch (error) {
				// A read failure is not "examined": leave the row NULL so the next
				// boot retries, and say so rather than sweeping silently.
				failed += 1;
				console.warn(`backfill: could not read record ${digest}: ${error instanceof Error ? error.message : error}`);
				continue;
			}
			if (!record) {
				failed += 1;
				continue;
			}
			const payloadRef = record.payload as { digest?: unknown } | undefined;
			this.index.setDerived(digest, {
				harness: typeof record.harness === "string" && record.harness.length > 0 ? record.harness : null,
				payload_digest: typeof payloadRef?.digest === "string" ? payloadRef.digest : null,
				provenance: typeof record.provenance === "string" ? record.provenance : null,
				observed: record.observed === false ? 0 : 1,
			});
			examined += 1;
		}
		return { examined, failed };
	}

	/** SRV-001.10.1. */
	async commitCoverage(sha: string): Promise<CoverageEntry> {
		const exact = this.index.bySha(sha);
		if (exact) {
			const record = (await this.readRecord(exact.digest)) as CommitEvidenceRecord | null;
			if (!record) return { sha, covered: false, reason: "record missing from store" };
			const status = sealStatus(record.capture);
			const failed = status === "failed-evidence";
			return {
				sha,
				covered: !failed,
				reason: failed ? "failed-evidence: required capture class missing" : "sealed commit evidence",
				evidence: exact.digest,
				match: "exact",
				status,
			};
		}
		return { sha, covered: false, reason: "no commit evidence for this SHA" };
	}

	/** A patch-id hit is reported as a derivation match, never as exact. SRV-001.4.10. */
	coverageByPatchId(patchId: string): CoverageEntry[] {
		return this.index.byPatchId(patchId).map((entry) => ({
			sha: entry.sha ?? "",
			covered: entry.status !== "failed-evidence",
			reason: "derivation match by patch id",
			evidence: entry.digest,
			match: "patch-id" as const,
			status: entry.status ?? undefined,
		}));
	}

	/** Returns the uncovered set, not a boolean alone. SRV-001.10.2. */
	async rangeCoverage(shas: string[]): Promise<{ covered: boolean; entries: CoverageEntry[]; uncovered: string[] }> {
		// Per-commit lookups are independent and each may be a store round trip,
		// so a release range resolves concurrently rather than serially.
		const entries = await Promise.all(shas.map((sha) => this.commitCoverage(sha)));
		const uncovered = entries.filter((entry) => !entry.covered).map((entry) => entry.sha);
		return { covered: uncovered.length === 0, entries, uncovered };
	}

	findings() {
		return this.index.findings();
	}
}
