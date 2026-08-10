/** What the store reports about an applied object lock. */
export interface Retention {
	mode: "COMPLIANCE" | "GOVERNANCE";
	retain_until: string;
}

export interface PutResult {
	locator: string;
	version?: string;
	/**
	 * The retention the STORE reports, read back after the write. Null when the
	 * backend cannot prove a lock — a development sink, or S3 without Object
	 * Lock configured. The sink must never substitute the value it requested.
	 * SRV-001.5.5.
	 */
	retention: Retention | null;
}

export interface HeadResult {
	locator: string;
	size: number;
	contentType?: string;
	checksumSha256?: string;
	etag?: string;
	version?: string;
}

export interface PresignedPut {
	method: "PUT";
	url: string;
	headers: Record<string, string>;
	expires_at: string;
}

export interface Store {
	readonly kind: string;
	/** True when this backend can prove a write-once lock. SRV-001.5.9. */
	readonly conforming: boolean;
	put(key: string, body: Uint8Array, options: { contentType: string; retainUntil?: Date }): Promise<PutResult>;
	/** A capability scoped to one exact object, checksum, retention, and short time window. */
	presignPut?(
		key: string,
		options: { digest: string; size: number; contentType: string; retainUntil: Date; expiresSeconds: number },
	): Promise<PresignedPut>;
	/** Object metadata, for the availability check SRV-001.5.10 requires of a verifier. */
	head(key: string): Promise<HeadResult | null>;
	get(key: string): Promise<Uint8Array | null>;
	getRetention(key: string, version?: string): Promise<Retention | null>;
}

export class StoreError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}
