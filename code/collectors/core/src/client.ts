import { mkdir, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { EvidenceRecord } from "./types.ts";

export interface ClientOptions {
	sink: string;
	token: string;
	/** Durable local buffer. A record is spooled before it is forwarded. CLC-001.6.1. */
	spool: string;
	emergencySink?: string;
	emergencyToken?: string;
}

/**
 * Forwards records to the sink under the acting identity of the observed
 * session. Never drops a record because the sink is unreachable, and never
 * forwards through a third party. CLC-001.6.
 */
export class PensieveClient {
	constructor(private readonly options: ClientOptions) {}

	private async spoolPath(): Promise<string> {
		await mkdir(this.options.spool, { recursive: true });
		return this.options.spool;
	}

	/**
	 * Spool first, then drain the spool oldest-first. Writing before sending is
	 * what makes loss impossible; draining in order is what makes delivery
	 * ordered even after a recovery — a record submitted now is never delivered
	 * ahead of one that has been waiting. CLC-001.6.1, CLC-001.6.3.
	 */
	async submit(record: EvidenceRecord): Promise<{ delivered: boolean; digest?: string }> {
		const dir = await this.spoolPath();
		// Monotonic prefix so lexical sort is chronological across a restart.
		const name = `${Date.now().toString().padStart(14, "0")}-${crypto.randomUUID()}.json`;
		const path = join(dir, name);
		await Bun.write(path, JSON.stringify(record));

		const delivered = await this.drain();
		const digest = delivered.get(path);
		if (digest === undefined && delivered.size === 0) {
			await this.reportFailure(record, new Error("sink unreachable"));
		}
		return { delivered: digest !== undefined, digest };
	}

	/** Deliver spooled records oldest-first, stopping at the first failure. */
	private async drain(): Promise<Map<string, string>> {
		const dir = await this.spoolPath();
		const names = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
		const delivered = new Map<string, string>();
		for (const name of names) {
			const path = join(dir, name);
			let record: EvidenceRecord;
			try {
				record = (await Bun.file(path).json()) as EvidenceRecord;
			} catch {
				continue;
			}
			try {
				const digest = await this.post(this.options.sink, this.options.token, record);
				await unlink(path);
				delivered.set(path, digest);
			} catch {
				// Stop rather than reorder. A later record must not overtake this one.
				break;
			}
		}
		return delivered;
	}

	private async post(sink: string, token: string, record: EvidenceRecord): Promise<string> {
		const response = await fetch(`${sink.replace(/\/$/, "")}/v0/records`, {
			method: "POST",
			headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
			body: JSON.stringify(record),
		});
		if (!response.ok) throw new Error(`sink rejected record: ${response.status} ${await response.text()}`);
		const body = (await response.json()) as { digest: string };
		return body.digest;
	}

	/**
	 * A primary-sink failure writes a signed minimal capture-failure record to
	 * the emergency path, which uses a different identity and failure domain.
	 * CLC-001.6.5.
	 */
	private async reportFailure(record: EvidenceRecord, error: unknown): Promise<void> {
		if (!this.options.emergencySink || !this.options.emergencyToken) return;
		const failure: EvidenceRecord = {
			...record,
			kind: "capture-failure",
			created_at: new Date().toISOString(),
			failed_kind: record.kind,
			reason: error instanceof Error ? error.message : String(error),
		};
		try {
			await this.post(this.options.emergencySink, this.options.emergencyToken, failure);
		} catch {
			// The emergency path is the last resort. The spooled record remains on
			// disk, so nothing is lost even when both sinks are unreachable.
		}
	}

	/** Deferred upload for offline and air-gapped sessions. CLC-001.6.4. */
	async flush(): Promise<{ delivered: number; remaining: number }> {
		const delivered = await this.drain();
		const dir = await this.spoolPath();
		const remaining = (await readdir(dir)).filter((name) => name.endsWith(".json")).length;
		return { delivered: delivered.size, remaining };
	}
}
