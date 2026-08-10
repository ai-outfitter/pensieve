import { canonicalize } from "./canonical.ts";

/**
 * The sink signing identity. Distinct from every agent identity and every
 * human identity. SRV-001.1.1.
 *
 * A deployment with no configured key generates an ephemeral one and declares
 * itself an unattested development sink, which marks every record it accepts
 * non-conforming. SRV-001.1.6.
 */
export interface SinkIdentity {
	id: string;
	key_id: string;
	public_key: string;
	attested: boolean;
}

export class Signer {
	private constructor(
		readonly identity: SinkIdentity,
		private readonly privateKey: CryptoKey,
	) {}

	static async create(options: { id: string; privateKeyPkcs8Base64?: string }): Promise<Signer> {
		let pair: { privateKey: CryptoKey; publicKey: CryptoKey };
		let attested = false;

		if (options.privateKeyPkcs8Base64) {
			const pkcs8 = Uint8Array.from(atob(options.privateKeyPkcs8Base64), (c) => c.charCodeAt(0));
			const privateKey = await crypto.subtle.importKey("pkcs8", pkcs8, { name: "Ed25519" }, true, [
				"sign",
			]);
			const jwk = await crypto.subtle.exportKey("jwk", privateKey);
			const publicKey = await crypto.subtle.importKey(
				"jwk",
				{ kty: jwk.kty, crv: jwk.crv, x: jwk.x },
				{ name: "Ed25519" },
				true,
				["verify"],
			);
			pair = { privateKey, publicKey };
			attested = true;
		} else {
			pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
				"sign",
				"verify",
			])) as unknown as CryptoKeyPair;
		}

		const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
		const publicKeyBase64 = btoa(String.fromCharCode(...raw));
		const keyId = publicKeyBase64.slice(0, 16);
		return new Signer(
			{ id: options.id, key_id: keyId, public_key: publicKeyBase64, attested },
			pair.privateKey,
		);
	}

	async sign(statement: Record<string, unknown>): Promise<string> {
		const bytes = new TextEncoder().encode(canonicalize(statement));
		const signature = new Uint8Array(
			await crypto.subtle.sign({ name: "Ed25519" }, this.privateKey, bytes),
		);
		return btoa(String.fromCharCode(...signature));
	}
}

/**
 * The sink's signed proof that a payload exists and is locked until a stated
 * time. It binds the record digest, the content digest, the object version,
 * the sink identity, the storage mechanism, and the retain-until date the
 * store reported. SRV-001.5.4.
 */
export interface StorageStatement {
	record_digest: string;
	content_digest: string;
	locator: string;
	object_version?: string;
	sink: string;
	key_id: string;
	mechanism: string;
	retain_until: string | null;
	lock_verified: boolean;
	conforming: boolean;
	issued_at: string;
	signature?: string;
}

/** A signed receipt for an opaque payload, which has no record digest yet. */
export interface PayloadStatement {
	content_digest: string;
	locator: string;
	object_version?: string;
	size: number;
	content_type?: string;
	sink: string;
	key_id: string;
	mechanism: string;
	retain_until: string | null;
	lock_verified: boolean;
	conforming: boolean;
	issued_at: string;
	signature?: string;
}
