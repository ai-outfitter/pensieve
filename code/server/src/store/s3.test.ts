import { describe, expect, test } from "bun:test";
import { sha256Hex } from "../canonical.ts";
import { RecordIndex } from "../db.ts";
import { Signer } from "../identity.ts";
import { Sink } from "../sink.ts";
import { S3Store } from "./s3.ts";
import { signRequest } from "./sigv4.ts";

const OPTIONS = {
	endpoint: "https://objects.example.test",
	bucket: "evidence",
	region: "us-east-1",
	accessKeyId: "test-access-key",
	secretAccessKey: "test-secret-key",
};

describe("S3 presigned PUT", () => {
	test("binds one payload key, checksum, size, lock, method, and short expiry", async () => {
		const store = new S3Store(OPTIONS);
		const digest = sha256Hex("payload");
		const retainUntil = new Date("2027-01-01T00:00:00.000Z");
		const result = await store.presignPut(`payloads/${digest.slice(0, 2)}/${digest}`, {
			digest,
			size: 7,
			contentType: "text/plain",
			retainUntil,
			expiresSeconds: 300,
		});
		const url = new URL(result.url);

		expect(result.method).toBe("PUT");
		expect(url.pathname).toBe(`/evidence/payloads/${digest.slice(0, 2)}/${digest}`);
		expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
		expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe(
			"content-length;content-type;host;x-amz-checksum-sha256;x-amz-object-lock-mode;x-amz-object-lock-retain-until-date",
		);
		expect(result.headers).toEqual({
			"content-length": "7",
			"content-type": "text/plain",
			"x-amz-checksum-sha256": Buffer.from(digest, "hex").toString("base64"),
			"x-amz-object-lock-mode": "COMPLIANCE",
			"x-amz-object-lock-retain-until-date": retainUntil.toISOString(),
		});
		expect(new Date(result.expires_at).getTime() - Date.now()).toBeWithin(298_000, 301_000);
	});

	test("resolves credentials for each presigned request", async () => {
		let calls = 0;
		const store = new S3Store({
			...OPTIONS,
			accessKeyId: undefined,
			secretAccessKey: undefined,
			credentialProvider: {
				async getCredentials() {
					calls += 1;
					return { accessKeyId: `request-${calls}`, secretAccessKey: "secret" };
				},
			},
		});
		const request = {
			digest: sha256Hex("payload"),
			size: 7,
			contentType: "text/plain",
			retainUntil: new Date("2027-01-01T00:00:00.000Z"),
			expiresSeconds: 300,
		};

		const first = await store.presignPut("payloads/first", request);
		const second = await store.presignPut("payloads/second", request);
		expect(new URL(first.url).searchParams.get("X-Amz-Credential")).toStartWith("request-1/");
		expect(new URL(second.url).searchParams.get("X-Amz-Credential")).toStartWith("request-2/");
		expect(calls).toBe(2);
	});
});

const integrationEndpoint = Bun.env.PENSIEVE_S3_TEST_ENDPOINT;
const integrationTest = integrationEndpoint ? test : test.skip;

/**
 * Object Lock can only be enabled when a bucket is created, so a test that
 * assumes a locked bucket already exists passes only on the machine that
 * happened to make one. Create it here instead, and make it idempotent.
 */
async function ensureLockedBucket(options: {
	endpoint: string;
	bucket: string;
	region: string;
	accessKeyId: string;
	secretAccessKey: string;
}): Promise<void> {
	const url = new URL(`${options.endpoint.replace(/\/$/, "")}/${options.bucket}`);
	const headers = signRequest(
		{
			method: "PUT",
			url,
			headers: { "x-amz-bucket-object-lock-enabled": "true" },
			body: new Uint8Array(),
		},
		{
			accessKeyId: options.accessKeyId,
			secretAccessKey: options.secretAccessKey,
			region: options.region,
			service: "s3",
		},
	);
	const response = await fetch(url, { method: "PUT", headers, body: new Uint8Array() });
	if (response.ok) return;
	const text = await response.text();
	// Only "already ours" is acceptable. BucketAlreadyExists means the name is
	// taken by somebody else, and silently proceeding would run this test against
	// a foreign bucket and report whatever that bucket's lock policy happens to
	// be — a misleading pass.
	if (/BucketAlreadyOwnedByYou/.test(text)) return;
	throw new Error(`could not create a lock-enabled bucket: ${response.status} ${text}`);
}

describe("S3 presigned PUT against object store", () => {
	integrationTest("rejects checksum and lock tampering, then seals exact store metadata", async () => {
		const store = new S3Store({
			endpoint: integrationEndpoint as string,
			bucket: Bun.env.PENSIEVE_S3_TEST_BUCKET ?? "pensieve",
			region: Bun.env.PENSIEVE_S3_TEST_REGION ?? "us-east-1",
			accessKeyId: Bun.env.PENSIEVE_S3_TEST_ACCESS_KEY_ID ?? "pensieve",
			secretAccessKey: Bun.env.PENSIEVE_S3_TEST_SECRET_ACCESS_KEY ?? "pensieve-dev-secret",
		});
		await ensureLockedBucket({
			endpoint: integrationEndpoint as string,
			bucket: Bun.env.PENSIEVE_S3_TEST_BUCKET ?? "pensieve",
			region: Bun.env.PENSIEVE_S3_TEST_REGION ?? "us-east-1",
			accessKeyId: Bun.env.PENSIEVE_S3_TEST_ACCESS_KEY_ID ?? "pensieve",
			secretAccessKey: Bun.env.PENSIEVE_S3_TEST_SECRET_ACCESS_KEY ?? "pensieve-dev-secret",
		});

		const bytes = new TextEncoder().encode(`presign integration ${crypto.randomUUID()}`);
		const wrong = new Uint8Array(bytes.byteLength).fill(120);
		const digest = sha256Hex(bytes);
		const key = `payloads/${digest.slice(0, 2)}/${digest}`;
		const signed = await store.presignPut(key, {
			digest,
			size: bytes.byteLength,
			contentType: "application/octet-stream",
			retainUntil: new Date(Date.now() + 8 * 86_400_000),
			expiresSeconds: 60,
		});

		const wrongResponse = await fetch(signed.url, { method: signed.method, headers: signed.headers, body: wrong });
		const wrongText = await wrongResponse.text();
		console.log(`wrong checksum: ${wrongResponse.status} ${/XAmzContentChecksumMismatch/.test(wrongText) ? "XAmzContentChecksumMismatch" : wrongText}`);
		expect(wrongResponse.status).toBe(400);
		expect(wrongText).toContain("XAmzContentChecksumMismatch");

		const changedMethod = await fetch(signed.url, { method: "POST", headers: signed.headers, body: bytes });
		console.log(`method changed: ${changedMethod.status}`);
		expect(changedMethod.ok).toBe(false);
		const changedKeyUrl = new URL(signed.url);
		changedKeyUrl.pathname += "-different-key";
		const changedKey = await fetch(changedKeyUrl, { method: signed.method, headers: signed.headers, body: bytes });
		console.log(`key changed: ${changedKey.status}`);
		expect(changedKey.ok).toBe(false);

		for (const [label, mutate] of [
			["lock omitted", (headers: Record<string, string>) => delete headers["x-amz-object-lock-mode"]],
			["lock weakened", (headers: Record<string, string>) => { headers["x-amz-object-lock-mode"] = "GOVERNANCE"; }],
			["retention omitted", (headers: Record<string, string>) => delete headers["x-amz-object-lock-retain-until-date"]],
			["retention shortened", (headers: Record<string, string>) => { headers["x-amz-object-lock-retain-until-date"] = new Date(Date.now() + 60_000).toISOString(); }],
		] as const) {
			const headers = { ...signed.headers };
			mutate(headers);
			const response = await fetch(signed.url, { method: signed.method, headers, body: bytes });
			console.log(`${label}: ${response.status}`);
			expect(response.ok).toBe(false);
		}

		const accepted = await fetch(signed.url, { method: signed.method, headers: signed.headers, body: bytes });
		console.log(`exact signed request: ${accepted.status}`);
		expect(accepted.status).toBe(200);
		const head = await store.head(key);
		expect(head?.size).toBe(bytes.byteLength);
		expect(head?.checksumSha256).toBe(Buffer.from(digest, "hex").toString("base64"));
		expect(head?.version).toBeTruthy();
		const retention = await store.getRetention(key, head?.version);
		expect(retention?.mode).toBe("COMPLIANCE");
		expect(retention?.retain_until).toBeTruthy();
		if (!head || !retention) throw new Error("object metadata was not returned");

		const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as unknown as CryptoKeyPair;
		const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
		const signer = await Signer.create({
			id: "integration.sink",
			privateKeyPkcs8Base64: Buffer.from(pkcs8).toString("base64"),
		});
		const sealed = await new Sink(store, signer, new RecordIndex(":memory:"), 7).sealPayload(digest);
		expect(sealed.statement.object_version).toBe(head.version);
		expect(sealed.statement.retain_until).toBe(retention.retain_until);
		expect(sealed.statement.signature).toBeTruthy();
	});
});
