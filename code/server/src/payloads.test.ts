import { describe, expect, test } from "bun:test";
import { RecordIndex } from "./db.ts";
import { Signer } from "./identity.ts";
import { Sink } from "./sink.ts";
import type { HeadResult, PutResult, Retention, Store } from "./store/types.ts";

async function attestedSigner(): Promise<Signer> {
	const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]) as unknown as CryptoKeyPair;
	const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
	return Signer.create({ id: "test.sink", privateKeyPkcs8Base64: Buffer.from(pkcs8).toString("base64") });
}

class SealStore implements Store {
	readonly kind = "s3";
	readonly conforming = true;
	retentionVersion: string | undefined;
	presignPut = async () => {
		throw new Error("not used");
	};

	async put(): Promise<PutResult> {
		throw new Error("not used");
	}
	async head(): Promise<HeadResult> {
		return {
			locator: "https://objects.example.test/pensieve/payload",
			size: 42,
			contentType: "text/plain",
			version: "version-from-head",
			checksumSha256: Buffer.from("a".repeat(64), "hex").toString("base64"),
		};
	}
	async get(): Promise<Uint8Array | null> {
		throw new Error("not used");
	}
	async getRetention(_key: string, version?: string): Promise<Retention> {
		this.retentionVersion = version;
		return { mode: "COMPLIANCE", retain_until: "2027-02-03T04:05:06.000Z" };
	}
}

describe("payload seal", () => {
	test("signs the version and retain-until values read back from the store", async () => {
		const store = new SealStore();
		const sink = new Sink(store, await attestedSigner(), new RecordIndex(":memory:"), 7);
		const digest = "a".repeat(64);
		const sealed = await sink.sealPayload(digest);

		expect(store.retentionVersion).toBe("version-from-head");
		expect(sealed.statement.object_version).toBe("version-from-head");
		expect(sealed.statement.retain_until).toBe("2027-02-03T04:05:06.000Z");
		expect(sealed.statement.lock_verified).toBe(true);
		expect(sealed.statement.conforming).toBe(true);
		expect(sealed.statement.signature).toBeTruthy();
	});

	test("refuses to seal a checksum that the store reports as different", async () => {
		const store = new SealStore();
		store.head = async () => ({
			locator: "https://objects.example.test/pensieve/payload",
			size: 42,
			version: "v1",
			checksumSha256: Buffer.alloc(32, 1).toString("base64"),
		});
		const sink = new Sink(store, await attestedSigner(), new RecordIndex(":memory:"), 7);
		await expect(sink.sealPayload("a".repeat(64))).rejects.toEqual(
			expect.objectContaining({ status: 409 }),
		);
	});
});
