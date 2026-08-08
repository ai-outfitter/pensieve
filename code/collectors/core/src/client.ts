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

	/** Spool first, then attempt delivery. Order is what makes loss impossible. */
	async submit(record: EvidenceRecord): Promise<{ delivered: boolean; digest?: string }> {
		const dir = await this.spoolPath();
		const name = `${Date.now()}-${crypto.randomUUID()}.json`;
		const path = join(dir, name);
		await Bun.write(path, JSON.stringify(record));

		try {
			const digest = await this.post(this.options.sink, this.options.token, record);
			await unlink(path);
			return { delivered: true, digest };
		} catch (error) {
			await this.reportFailure(record, error);
			return { delivered: false };
		}
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
		const dir = await this.spoolPath();
		const names = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
		let delivered = 0;
		for (const name of names) {
			const path = join(dir, name);
			const record = (await Bun.file(path).json()) as EvidenceRecord;
			try {
				await this.post(this.options.sink, this.options.token, record);
				await unlink(path);
				delivered += 1;
			} catch {
				// Ordered delivery: stop at the first failure rather than reorder.
				break;
			}
		}
		const remaining = (await readdir(dir)).filter((name) => name.endsWith(".json")).length;
		return { delivered, remaining };
	}
}
