import { signRequest, type SigV4Credentials } from "./sigv4.ts";
import { StoreError, type HeadResult, type PutResult, type Retention, type Store } from "./types.ts";

export interface S3StoreOptions {
	endpoint: string;
	bucket: string;
	region: string;
	accessKeyId: string;
	secretAccessKey: string;
	sessionToken?: string;
	/** Path style is required for MinIO and for any endpoint without bucket DNS. */
	pathStyle?: boolean;
}

/**
 * The default backend: S3 with Object Lock in compliance mode on a versioned
 * bucket. SRV-001.5.7.
 */
export class S3Store implements Store {
	readonly kind = "s3";
	readonly conforming = true;
	private readonly credentials: SigV4Credentials;

	constructor(private readonly options: S3StoreOptions) {
		this.credentials = {
			accessKeyId: options.accessKeyId,
			secretAccessKey: options.secretAccessKey,
			sessionToken: options.sessionToken,
			region: options.region,
			service: "s3",
		};
	}

	private url(key: string, query?: string): URL {
		const base = this.options.endpoint.replace(/\/$/, "");
		const path =
			this.options.pathStyle === false
				? `${base}/${key}`
				: `${base}/${this.options.bucket}/${key}`;
		const url = new URL(path);
		if (query) url.search = query;
		return url;
	}

	private async send(
		method: string,
		url: URL,
		headers: Record<string, string> = {},
		body?: Uint8Array,
	): Promise<Response> {
		const signed = signRequest({ method, url, headers, body }, this.credentials);
		return fetch(url, { method, headers: signed, body });
	}

	async put(
		key: string,
		body: Uint8Array,
		options: { contentType: string; retainUntil?: Date },
	): Promise<PutResult> {
		const headers: Record<string, string> = { "content-type": options.contentType };
		if (options.retainUntil) {
			// Apply the lock as part of the write, before any statement is signed.
			// SRV-001.5.3.
			headers["x-amz-object-lock-mode"] = "COMPLIANCE";
			headers["x-amz-object-lock-retain-until-date"] = options.retainUntil.toISOString();
		}
		const response = await this.send("PUT", this.url(key), headers, body);
		if (!response.ok) {
			throw new StoreError(`s3 put failed: ${response.status} ${await response.text()}`, 502);
		}
		// Read the applied retention back from the store. What the store reports
		// is what gets signed; the requested value is never substituted.
		// SRV-001.5.5.
		const retention = await this.getRetention(key);
		return {
			locator: this.url(key).toString(),
			version: response.headers.get("x-amz-version-id") ?? undefined,
			retention,
		};
	}

	async head(key: string): Promise<HeadResult | null> {
		const response = await this.send("HEAD", this.url(key));
		if (response.status === 404) return null;
		if (!response.ok) throw new StoreError(`s3 head failed: ${response.status}`, 502);
		return {
			size: Number(response.headers.get("content-length") ?? 0),
			etag: response.headers.get("etag") ?? undefined,
			version: response.headers.get("x-amz-version-id") ?? undefined,
		};
	}

	async get(key: string): Promise<Uint8Array | null> {
		const response = await this.send("GET", this.url(key));
		if (response.status === 404) return null;
		if (!response.ok) throw new StoreError(`s3 get failed: ${response.status}`, 502);
		return new Uint8Array(await response.arrayBuffer());
	}

	async getRetention(key: string): Promise<Retention | null> {
		const response = await this.send("GET", this.url(key, "retention"));
		if (!response.ok) return null;
		const xml = await response.text();
		const mode = /<Mode>([^<]+)<\/Mode>/.exec(xml)?.[1];
		const until = /<RetainUntilDate>([^<]+)<\/RetainUntilDate>/.exec(xml)?.[1];
		if (!mode || !until) return null;
		return { mode: mode as Retention["mode"], retain_until: new Date(until).toISOString() };
	}
}
