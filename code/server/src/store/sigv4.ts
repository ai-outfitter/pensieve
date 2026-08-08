import { createHash, createHmac } from "node:crypto";

/**
 * Minimal AWS Signature Version 4 for S3.
 *
 * Written by hand rather than taken from an SDK because Pensieve needs two
 * things a convenience client does not expose: a PUT that carries
 * `x-amz-object-lock-retain-until-date`, and a GET of the `?retention`
 * subresource. Applying the lock and then reading it back is the whole
 * substance of SRV-001.5.3 – SRV-001.5.5 — the sink must never sign the
 * retention value it asked for, only the one the store reports.
 */
export interface SigV4Credentials {
	accessKeyId: string;
	secretAccessKey: string;
	sessionToken?: string;
	region: string;
	service: string;
}

export interface SignableRequest {
	method: string;
	url: URL;
	headers: Record<string, string>;
	body?: Uint8Array;
}

const UNSIGNED_HEADERS = new Set(["authorization", "content-length", "user-agent"]);

function hmac(key: Uint8Array | string, data: string): Uint8Array {
	return new Uint8Array(createHmac("sha256", key).update(data).digest());
}

function hexSha256(data: Uint8Array | string): string {
	return createHash("sha256").update(data).digest("hex");
}

/** S3 requires each path segment encoded, but not the separators. */
function canonicalUri(pathname: string): string {
	return pathname
		.split("/")
		.map((segment) => encodeURIComponent(decodeURIComponent(segment)).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
		.join("/");
}

function canonicalQuery(url: URL): string {
	const entries = [...url.searchParams.entries()].sort(([a, av], [b, bv]) =>
		a === b ? (av < bv ? -1 : 1) : a < b ? -1 : 1,
	);
	return entries
		.map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
		.join("&");
}

export function signRequest(request: SignableRequest, credentials: SigV4Credentials): Headers {
	const now = new Date();
	const amzDate = `${now.toISOString().replace(/[-:]/g, "").slice(0, 15)}Z`;
	const dateStamp = amzDate.slice(0, 8);
	const payloadHash = hexSha256(request.body ?? new Uint8Array());

	const headers: Record<string, string> = {
		...request.headers,
		host: request.url.host,
		"x-amz-content-sha256": payloadHash,
		"x-amz-date": amzDate,
	};
	if (credentials.sessionToken) headers["x-amz-security-token"] = credentials.sessionToken;

	const signable = Object.entries(headers)
		.map(([key, value]) => [key.toLowerCase(), value.trim().replace(/\s+/g, " ")] as const)
		.filter(([key]) => !UNSIGNED_HEADERS.has(key))
		.sort(([a], [b]) => (a < b ? -1 : 1));

	const signedHeaders = signable.map(([key]) => key).join(";");
	const canonicalHeaders = signable.map(([key, value]) => `${key}:${value}\n`).join("");

	const canonicalRequest = [
		request.method.toUpperCase(),
		canonicalUri(request.url.pathname),
		canonicalQuery(request.url),
		canonicalHeaders,
		signedHeaders,
		payloadHash,
	].join("\n");

	const scope = `${dateStamp}/${credentials.region}/${credentials.service}/aws4_request`;
	const stringToSign = [
		"AWS4-HMAC-SHA256",
		amzDate,
		scope,
		hexSha256(canonicalRequest),
	].join("\n");

	let signingKey = hmac(`AWS4${credentials.secretAccessKey}`, dateStamp);
	signingKey = hmac(signingKey, credentials.region);
	signingKey = hmac(signingKey, credentials.service);
	signingKey = hmac(signingKey, "aws4_request");
	const signature = Buffer.from(hmac(signingKey, stringToSign)).toString("hex");

	const result = new Headers(headers);
	result.set(
		"authorization",
		`AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
	);
	return result;
}
