import { canonicalize, sha256Hex } from "./canonical.ts";
import { RecordIndex, type IndexedRecord } from "./db.ts";
import type { Signer, StorageStatement } from "./identity.ts";
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
import type { Store } from "./store/types.ts";

const ENCODER = new TextEncoder();
const DECODER = new TextDecoder();

/**
 * Which columns each kind contributes to the lookup index. A per-kind
 * projection keeps one column from meaning two things: `sha` is always the
 * commit a record covers, and a landing's new ref head has its own column.
 */
function projectForIndex(record: BaseRecord): Omit<IndexedRecord, "digest" | "kind" | "run" | "identity" | "created_at"> {
	const empty = { sha: null, patch_id: null, ref: null, ref_head: null, tag: null, status: null };
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
