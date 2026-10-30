/**
 * One canonical serialization, so a record digest is reproducible by any
 * verifier that holds the record. SRV-001.3.3.
 *
 * Object keys sort by code unit. No insignificant whitespace. `undefined`
 * members are dropped rather than encoded, so an absent field and a field set
 * to `undefined` produce the same bytes.
 *
 * Pure: no runtime imports, so it runs under Bun, Node, and Workers. The server
 * re-exports it from `server/src/canonical.ts`.
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

const ENCODER = new TextEncoder();

/** Lowercase hex SHA-256 via Web Crypto. */
export async function sha256Hex(data: string | Uint8Array): Promise<string> {
	const bytes = typeof data === "string" ? ENCODER.encode(data) : data;
	const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
	return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** SHA-256 of the canonical serialization of `value`. */
export function canonicalDigest(value: unknown): Promise<string> {
	return sha256Hex(canonicalize(value));
}
