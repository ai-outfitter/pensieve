import { sha256Hex } from "../canonical.ts";
import { presignRequest, signRequest, type SigV4Credentials } from "./sigv4.ts";
import {
	createCredentialProvider,
	type CredentialProvider,
	type CredentialSourceOptions,
} from "./credentials.ts";
import {
	StoreError,
	type HeadResult,
	type PresignedPut,
	type PutResult,
	type Retention,
	type Store,
} from "./types.ts";

export interface S3StoreOptions extends CredentialSourceOptions {
	endpoint: string;
	bucket: string;
	/** Path style is required for MinIO and for any endpoint without bucket DNS. */
	pathStyle?: boolean;
	/** Overrides source selection for tests or embedding. */
	credentialProvider?: CredentialProvider;
}

/**
 * The default backend: S3 with Object Lock in compliance mode on a versioned
 * bucket. SRV-001.5.7.
 */
export class S3Store implements Store {
	readonly kind = "s3";
	readonly conforming = true;
	private readonly credentialProvider: CredentialProvider;

	constructor(private readonly options: S3StoreOptions) {
		this.credentialProvider = options.credentialProvider ?? createCredentialProvider(options);
	}

	private async credentials(): Promise<SigV4Credentials> {
		return {
			...(await this.credentialProvider.getCredentials()),
			region: this.options.region,
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
		const signed = signRequest({ method, url, headers, body }, await this.credentials());
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
			// AWS rejects a PUT carrying object-lock parameters unless it also
			// carries a checksum: "Content-MD5 OR x-amz-checksum- HTTP header is
			// required for Put Object requests with Object Lock parameters."
			// MinIO does not enforce this, so it only appears against real S3.
			// The store is content-addressed, so the checksum is already known.
			headers["x-amz-checksum-sha256"] = Buffer.from(sha256Hex(body), "hex").toString("base64");
		}
		const response = await this.send("PUT", this.url(key), headers, body);
		if (!response.ok) {
			throw new StoreError(`s3 put failed: ${response.status} ${await response.text()}`, 502);
		}
		// Read the applied retention back from the store. What the store reports
		// is what gets signed; the requested value is never substituted.
		// SRV-001.5.5.
		const version = response.headers.get("x-amz-version-id") ?? undefined;
		const retention = await this.getRetention(key, version);
		return {
			locator: this.url(key).toString(),
			version,
			retention,
		};
	}

	async presignPut(
		key: string,
		options: { digest: string; size: number; contentType: string; retainUntil: Date; expiresSeconds: number },
	): Promise<PresignedPut> {
		const now = new Date();
		const headers = {
			"content-length": String(options.size),
			"content-type": options.contentType,
			"x-amz-checksum-sha256": Buffer.from(options.digest, "hex").toString("base64"),
			"x-amz-object-lock-mode": "COMPLIANCE",
			"x-amz-object-lock-retain-until-date": options.retainUntil.toISOString(),
		};
		const url = presignRequest(
			{ method: "PUT", url: this.url(key), headers, expiresSeconds: options.expiresSeconds },
			await this.credentials(),
			now,
		);
		return {
			method: "PUT",
			url: url.toString(),
			headers,
			expires_at: new Date(now.getTime() + options.expiresSeconds * 1000).toISOString(),
		};
	}

	async head(key: string): Promise<HeadResult | null> {
		const response = await this.send("HEAD", this.url(key), { "x-amz-checksum-mode": "ENABLED" });
		if (response.status === 404) return null;
		if (!response.ok) throw new StoreError(`s3 head failed: ${response.status}`, 502);
		return {
			locator: this.url(key).toString(),
			size: Number(response.headers.get("content-length") ?? 0),
			contentType: response.headers.get("content-type") ?? undefined,
			checksumSha256: response.headers.get("x-amz-checksum-sha256") ?? undefined,
			etag: response.headers.get("etag") ?? undefined,
			version: response.headers.get("x-amz-version-id") ?? undefined,
		};
	}

	async get(key: string, version?: string): Promise<Uint8Array | null> {
		const url = this.url(key);
		// A delete marker hides the latest version from an unversioned GET while
		// the retained bytes still exist; pinning the version HEAD reported reads
		// through it.
		if (version) url.searchParams.set("versionId", version);
		const response = await this.send("GET", url);
		if (response.status === 404) return null;
		if (!response.ok) throw new StoreError(`s3 get failed: ${response.status}`, 502);
		return new Uint8Array(await response.arrayBuffer());
	}

	async getRetention(key: string, version?: string): Promise<Retention | null> {
		const url = this.url(key, "retention");
		if (version) url.searchParams.set("versionId", version);
		const response = await this.send("GET", url);
		// Absence of a lock is a 404/no-configuration answer. Any other failure
		// is an ERROR and must not read as "unlocked" — serving evidence with
		// the lock headers silently missing conflates a transient store fault
		// with an unretained object.
		if (response.status === 404) return null;
		if (!response.ok) throw new StoreError(`s3 get retention failed: ${response.status}`, 502);
		const xml = await response.text();
		const mode = /<Mode>([^<]+)<\/Mode>/.exec(xml)?.[1];
		const until = /<RetainUntilDate>([^<]+)<\/RetainUntilDate>/.exec(xml)?.[1];
		if (!mode || !until) return null;
		return { mode: mode as Retention["mode"], retain_until: new Date(until).toISOString() };
	}
}
