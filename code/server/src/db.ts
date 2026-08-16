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
	/** For a landing, the ref's new head, so the next update's `before` can be compared. */
	ref_head: string | null;
	tag: string | null;
	status: string | null;
	harness: string | null;
	payload_digest: string | null;
	provenance: string | null;
	/** 1 observed, 0 backfilled/imported, NULL where the record predates the column and is unexamined. */
	observed: number | null;
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
				ref_head    TEXT,
				tag         TEXT,
				status      TEXT,
				harness     TEXT,
				payload_digest TEXT,
				provenance  TEXT,
				observed    INTEGER,
				received_at TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS records_sha      ON records (sha);
			CREATE INDEX IF NOT EXISTS records_patch_id ON records (patch_id);
			CREATE INDEX IF NOT EXISTS records_ref      ON records (ref, created_at);
			CREATE INDEX IF NOT EXISTS records_tag      ON records (tag);
			CREATE INDEX IF NOT EXISTS records_listing  ON records (created_at, digest);
			CREATE TABLE IF NOT EXISTS findings (
				id         INTEGER PRIMARY KEY AUTOINCREMENT,
				kind       TEXT NOT NULL,
				subject    TEXT NOT NULL,
				detail     TEXT NOT NULL,
				created_at TEXT NOT NULL
			);
		`);
		this.addMissingColumns();
	}

	/**
	 * `CREATE TABLE IF NOT EXISTS` is a no-op against an index created by an
	 * earlier version, so a newly added column has to be applied explicitly or
	 * every insert fails against an existing store. Records themselves are
	 * immutable and live in the object store; this index is derived and
	 * additive, so adding nullable columns is the whole migration story.
	 */
	private addMissingColumns(): void {
		const columns = new Set(
			(this.db.query("PRAGMA table_info(records)").all() as Array<{ name: string }>).map((c) => c.name),
		);
		for (const [name, type] of [
			["ref_head", "TEXT"],
			["harness", "TEXT"],
			["payload_digest", "TEXT"],
			["provenance", "TEXT"],
			["observed", "INTEGER"],
		] as const) {
			if (!columns.has(name)) this.db.run(`ALTER TABLE records ADD COLUMN ${name} ${type}`);
		}
	}

	insert(record: IndexedRecord): void {
		this.db
			.query(
				`INSERT OR IGNORE INTO records
				 (digest, kind, run, identity, created_at, sha, patch_id, ref, ref_head, tag, status, harness,
				  payload_digest, provenance, observed, received_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
				record.ref_head,
				record.tag,
				record.status,
				record.harness,
				record.payload_digest,
				record.provenance,
				record.observed,
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

	landingsForRef(ref: string): IndexedRecord[] {
		return this.db
			.query("SELECT * FROM records WHERE kind = 'landing' AND ref = ? ORDER BY created_at ASC")
			.all(ref) as IndexedRecord[];
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

	/**
	 * Enumerate records without a digest in hand. RTR-001.2.1, RTR-001.2.2.
	 *
	 * Keyset pagination on (created_at, digest): an opaque cursor names the
	 * last row returned, so concurrent ingest never shifts a page the way an
	 * OFFSET would. RTR-001.2.4. This is the INDEX speaking — fetch and verify
	 * the record itself from the store by its digest; a listing is a map,
	 * never evidence. SRV-001.10.5.
	 */
	search(filters: {
		kind?: string;
		run?: string;
		identity?: string;
		harness?: string;
		provenance?: string;
		observed?: boolean;
		since?: string;
		until?: string;
		limit: number;
		cursor?: { created_at: string; digest: string };
	}): IndexedRecord[] {
		const where: string[] = [];
		const args: string[] = [];
		for (const field of ["kind", "run", "identity", "harness", "provenance"] as const) {
			const value = filters[field];
			if (value !== undefined) {
				where.push(`${field} = ?`);
				args.push(value);
			}
		}
		if (filters.observed !== undefined) {
			where.push("observed = ?");
			args.push(filters.observed ? "1" : "0");
		}
		if (filters.since !== undefined) {
			where.push("created_at >= ?");
			args.push(filters.since);
		}
		if (filters.until !== undefined) {
			where.push("created_at < ?");
			args.push(filters.until);
		}
		if (filters.cursor !== undefined) {
			where.push("(created_at, digest) > (?, ?)");
			args.push(filters.cursor.created_at, filters.cursor.digest);
		}
		const clause = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
		return this.db
			.query(`SELECT * FROM records ${clause} ORDER BY created_at, digest LIMIT ?`)
			.all(...args, String(filters.limit)) as IndexedRecord[];
	}

	/**
	 * Rows indexed before the derived columns existed and not yet examined.
	 * `observed` doubles as the examined marker: the backfill always sets it,
	 * so a record WITHOUT the newer fields is recorded as examined rather
	 * than re-read from the store on every boot forever.
	 */
	unexamined(): string[] {
		return (this.db.query("SELECT digest FROM records WHERE observed IS NULL").all() as Array<{ digest: string }>).map(
			(row) => row.digest,
		);
	}

	setDerived(
		digest: string,
		derived: { harness: string | null; payload_digest: string | null; provenance: string | null; observed: number },
	): void {
		this.db
			.query("UPDATE records SET harness = ?, payload_digest = ?, provenance = ?, observed = ? WHERE digest = ?")
			.run(derived.harness, derived.payload_digest, derived.provenance, derived.observed, digest);
	}
}
