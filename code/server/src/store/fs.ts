import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { HeadResult, PutResult, Retention, Store } from "./types.ts";

/**
 * Development backend. It cannot prove a write-once lock, so it reports itself
 * non-conforming and returns no retention. Every record it holds is therefore
 * marked non-conforming by the sink, and a run can never accidentally look
 * audited because someone ran the demo stack. SRV-001.5.9, SRV-001.1.6.
 */
export class FilesystemStore implements Store {
	readonly kind = "filesystem";
	readonly conforming = false;

	constructor(private readonly root: string) {}

	private path(key: string): string {
		return join(this.root, key);
	}

	async put(key: string, body: Uint8Array, options: { contentType: string }): Promise<PutResult> {
		const path = this.path(key);
		await mkdir(dirname(path), { recursive: true });
		// Content-addressed and write-once by convention only: an existing key is
		// never overwritten, but nothing stops a privileged process. SRV-001.5.2.
		if (!(await Bun.file(path).exists())) {
			await Bun.write(path, body);
			// S3 stores the content type as object metadata; the filesystem has
			// no metadata, so a sidecar records it. The read path must return the
			// type recorded at seal time, never one sniffed from the bytes.
			// RTR-001.1.3.
			await Bun.write(`${path}.content-type`, options.contentType);
		}
		return { locator: `file://${path}`, retention: null };
	}

	async head(key: string): Promise<HeadResult | null> {
		const path = this.path(key);
		const file = Bun.file(path);
		if (!(await file.exists())) return null;
		const sidecar = Bun.file(`${path}.content-type`);
		const recorded = (await sidecar.exists()) ? (await sidecar.text()).trim() : "";
		// contentType is what was recorded at seal time; an empty string is
		// absence, not a value. RTR-001.1.3.
		return { locator: `file://${path}`, size: file.size, contentType: recorded || undefined };
	}

	async get(key: string, _version?: string): Promise<Uint8Array | null> {
		const file = Bun.file(this.path(key));
		if (!(await file.exists())) return null;
		return new Uint8Array(await file.arrayBuffer());
	}

	async getRetention(_key: string, _version?: string): Promise<Retention | null> {
		return null;
	}
}
