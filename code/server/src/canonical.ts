import { CryptoHasher } from "bun";
import { canonicalize } from "../../eval/src/canonical.ts";

// One implementation for the server and evaluation bundles (SRV-001.3.3, EVL-001.1.2).
export { canonicalize };

export function sha256Hex(data: string | Uint8Array | ArrayBuffer): string {
	const hasher = new CryptoHasher("sha256");
	hasher.update(data as never);
	return hasher.digest("hex");
}

/**
 * The record digest is computed over the canonical serialization, and it is
 * computed BEFORE any storage statement exists. The storage statement then
 * signs over this digest. That ordering is what avoids a digest cycle, and it
 * is a requirement rather than an implementation detail. SRV-001.3.4.
 */
export function recordDigest(record: unknown): string {
	return sha256Hex(canonicalize(record));
}
