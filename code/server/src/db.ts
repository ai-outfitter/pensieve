import { Database } from "bun:sqlite";

/**
 * A lookup index, and only that. Verification never reads its conclusions from
 * here — SRV-001.10.5 requires the verification path to read records back from
 * the store. This table exists so a coverage query knows which key to fetch.
 */
export interface IndexedRecord {
	digest: string;
	kind: string;
	run: string;
	identity: string;
	created_at: string;
	sha: string | null;
	patch_id: string | null;
	ref: string | null;
	tag: string | null;
	status: string | null;
}

export class RecordIndex {
	private readonly db: Database;

	constructor(path: string) {
		this.db = new Database(path, { create: true });
		this.db.run("PRAGMA journal_mode = WAL");
		this.db.run(`
			CREATE TABLE IF NOT EXISTS records (
				digest      TEXT PRIMARY KEY,
				kind        TEXT NOT NULL,
				run         TEXT NOT NULL,
				identity    TEXT NOT NULL,
				created_at  TEXT NOT NULL,
				sha         TEXT,
				patch_id    TEXT,
				ref         TEXT,
				tag         TEXT,
				status      TEXT,
				received_at TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS records_sha      ON records (sha);
			CREATE INDEX IF NOT EXISTS records_patch_id ON records (patch_id);
			CREATE INDEX IF NOT EXISTS records_ref      ON records (ref, created_at);
			CREATE INDEX IF NOT EXISTS records_tag      ON records (tag);
			CREATE TABLE IF NOT EXISTS findings (
				id         INTEGER PRIMARY KEY AUTOINCREMENT,
				kind       TEXT NOT NULL,
				subject    TEXT NOT NULL,
				detail     TEXT NOT NULL,
				created_at TEXT NOT NULL
			);
		`);
	}

	insert(record: IndexedRecord): void {
		this.db
			.query(
				`INSERT OR IGNORE INTO records
				 (digest, kind, run, identity, created_at, sha, patch_id, ref, tag, status, received_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				record.digest,
				record.kind,
				record.run,
				record.identity,
				record.created_at,
				record.sha,
				record.patch_id,
				record.ref,
				record.tag,
				record.status,
				new Date().toISOString(),
			);
	}

	/** Exact identity. SRV-001.4.9. */
	bySha(sha: string): IndexedRecord | null {
		return (
			(this.db
				.query("SELECT * FROM records WHERE kind = 'commit-evidence' AND sha = ? LIMIT 1")
				.get(sha) as IndexedRecord | null) ?? null
		);
	}

	/** Durable identity of the change, for rewritten history. SRV-001.4.10. */
	byPatchId(patchId: string): IndexedRecord[] {
		return this.db
			.query("SELECT * FROM records WHERE kind = 'commit-evidence' AND patch_id = ?")
			.all(patchId) as IndexedRecord[];
	}

	byDigest(digest: string): IndexedRecord | null {
		return (this.db.query("SELECT * FROM records WHERE digest = ?").get(digest) as IndexedRecord | null) ?? null;
	}

	landingsForRef(ref: string): IndexedRecord[] {
		return this.db
			.query("SELECT * FROM records WHERE kind = 'landing' AND ref = ? ORDER BY created_at ASC")
			.all(ref) as IndexedRecord[];
	}

	byTag(tag: string): IndexedRecord | null {
		return (
			(this.db
				.query("SELECT * FROM records WHERE kind = 'release-bundle' AND tag = ? ORDER BY created_at DESC LIMIT 1")
				.get(tag) as IndexedRecord | null) ?? null
		);
	}

	/** Findings append. They never mutate an existing record. SRV-001.8.5. */
	addFinding(kind: string, subject: string, detail: string): void {
		this.db
			.query("INSERT INTO findings (kind, subject, detail, created_at) VALUES (?, ?, ?, ?)")
			.run(kind, subject, detail, new Date().toISOString());
	}

	findings(): Array<{ kind: string; subject: string; detail: string; created_at: string }> {
		return this.db.query("SELECT kind, subject, detail, created_at FROM findings ORDER BY id DESC").all() as Array<{
			kind: string;
			subject: string;
			detail: string;
			created_at: string;
		}>;
	}

	close(): void {
		this.db.close();
	}
}
