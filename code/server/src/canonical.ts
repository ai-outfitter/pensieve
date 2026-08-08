import { CryptoHasher } from "bun";

/**
 * One canonical serialization, so a record digest is reproducible by any
 * verifier that holds the record. SRV-001.3.3.
 *
 * Object keys sort by code unit. No insignificant whitespace. `undefined`
 * members are dropped rather than encoded, so an absent field and a field set
 * to `undefined` produce the same bytes.
 */
export function canonicalize(value: unknown): string {
	if (value === null) return "null";
	if (typeof value === "number") {
		if (!Number.isFinite(value)) throw new Error("cannot canonicalize a non-finite number");
		return JSON.stringify(value);
	}
	if (typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
	if (Array.isArray(value)) return `[${value.map((item) => canonicalize(item ?? null)).join(",")}]`;
	if (typeof value === "object") {
		const source = value as Record<string, unknown>;
		const parts: string[] = [];
		for (const key of Object.keys(source).sort()) {
			const member = source[key];
			if (member === undefined) continue;
			parts.push(`${JSON.stringify(key)}:${canonicalize(member)}`);
		}
		return `{${parts.join(",")}}`;
	}
	throw new Error(`cannot canonicalize ${typeof value}`);
}

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
