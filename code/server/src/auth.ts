import type { Config } from "./config.ts";
import { AuthError, type Principal } from "./sink.ts";

type JwtHeader = { alg?: unknown; kid?: unknown; typ?: unknown };
type JwtClaims = { iss?: unknown; aud?: unknown; sub?: unknown; exp?: unknown; nbf?: unknown };
type Jwk = Record<string, unknown> & { kid?: string; alg?: string; use?: string };

const textDecoder = new TextDecoder();

function decodePart<T>(part: string): T {
	try {
		return JSON.parse(textDecoder.decode(Buffer.from(part, "base64url"))) as T;
	} catch {
		throw new AuthError("bearer token is not a valid JWT");
	}
}

function audienceIncludes(value: unknown, expected: string): boolean {
	return value === expected || (Array.isArray(value) && value.includes(expected));
}

function algorithm(alg: string) {
	if (alg === "RS256") return { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
	if (alg === "ES256") return { name: "ECDSA", namedCurve: "P-256" };
	throw new AuthError(`unsupported JWT algorithm "${alg}"`);
}

function verifyAlgorithm(alg: string) {
	return alg === "ES256" ? { name: "ECDSA", hash: "SHA-256" } : { name: "RSASSA-PKCS1-v1_5" };
}

/** Cached OIDC verification for production workload and auditor identities. */
export class OidcAuthenticator {
	private keys: { expiresAt: number; values: Jwk[] } | undefined;

	constructor(
		private readonly config: NonNullable<Config["oidc"]>,
		private readonly fetcher: typeof fetch = fetch,
		private readonly now: () => number = Date.now,
	) {}

	private async jwksUri(): Promise<string> {
		if (this.config.jwksUri) return this.config.jwksUri;
		const discovery = `${this.config.issuer.replace(/\/$/, "")}/.well-known/openid-configuration`;
		const response = await this.fetcher(discovery);
		if (!response.ok) throw new AuthError("OIDC discovery failed", 503);
		const body = await response.json() as { issuer?: unknown; jwks_uri?: unknown };
		if (body.issuer !== this.config.issuer || typeof body.jwks_uri !== "string") {
			throw new AuthError("OIDC discovery does not match the configured issuer", 503);
		}
		return body.jwks_uri;
	}

	private async loadKeys(force = false): Promise<Jwk[]> {
		if (!force && this.keys && this.keys.expiresAt > this.now()) return this.keys.values;
		const response = await this.fetcher(await this.jwksUri());
		if (!response.ok) throw new AuthError("OIDC key retrieval failed", 503);
		const body = await response.json() as { keys?: unknown };
		if (!Array.isArray(body.keys)) throw new AuthError("OIDC key set is invalid", 503);
		const values = body.keys.filter((value): value is Jwk => Boolean(value && typeof value === "object"));
		this.keys = { expiresAt: this.now() + 5 * 60_000, values };
		return values;
	}

	private async key(kid: string, alg: string): Promise<Jwk> {
		for (const force of [false, true]) {
			const found = (await this.loadKeys(force)).find((key) => key.kid === kid && (!key.alg || key.alg === alg));
			if (found) return found;
		}
		throw new AuthError("bearer token references an unknown signing key");
	}

	async authenticate(token: string): Promise<Principal> {
		const parts = token.split(".");
		if (parts.length !== 3 || parts.some((part) => part.length === 0)) throw new AuthError("bearer token is not a valid JWT");
		const [encodedHeader, encodedClaims, encodedSignature] = parts as [string, string, string];
		const header = decodePart<JwtHeader>(encodedHeader);
		const claims = decodePart<JwtClaims>(encodedClaims);
		if (header.typ !== undefined && header.typ !== "JWT") throw new AuthError("bearer token has an invalid type");
		if (typeof header.alg !== "string" || typeof header.kid !== "string") throw new AuthError("bearer token has no supported signing key");
		const key = await this.key(header.kid, header.alg);
		const imported = await crypto.subtle.importKey("jwk", key as never, algorithm(header.alg), false, ["verify"]);
		const valid = await crypto.subtle.verify(
			verifyAlgorithm(header.alg),
			imported,
			Buffer.from(encodedSignature, "base64url"),
			new TextEncoder().encode(`${encodedHeader}.${encodedClaims}`),
		);
		if (!valid) throw new AuthError("bearer token signature is invalid");

		const now = Math.floor(this.now() / 1000);
		if (claims.iss !== this.config.issuer || !audienceIncludes(claims.aud, this.config.audience)) {
			throw new AuthError("bearer token issuer or audience is invalid");
		}
		if (typeof claims.exp !== "number" || claims.exp <= now || (claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf > now))) {
			throw new AuthError("bearer token is expired or not active");
		}
		if (typeof claims.sub !== "string" || claims.sub.length === 0) throw new AuthError("bearer token has no subject");
		const canWrite = new RegExp(this.config.writeSubjectPattern).test(claims.sub);
		const canRead = this.config.readSubjectPattern ? new RegExp(this.config.readSubjectPattern).test(claims.sub) : false;
		if (!canWrite && !canRead) throw new AuthError("bearer token subject is not authorized", 403);
		return { identity: claims.sub, canWrite };
	}
}

/**
 * Ingest is always authenticated. SRV-001.2.1.
 *
 * Two token forms:
 *   `Bearer dev:<identity>`   — write, local stack only, requires PENSIEVE_DEV_AUTH=1
 *   `Bearer read:<identity>`  — read-only, what a CI gate receives (CICD-001.6.3)
 *
 * Production exchanges a forge or cluster OIDC token for a short-lived
 * credential (SRV-001.2.2). That exchange is not implemented yet, and an
 * unimplemented verifier must reject rather than wave traffic through.
 */
export async function authenticate(
	request: Request,
	devAuth: boolean,
	oidc?: OidcAuthenticator,
): Promise<Principal> {
	const header = request.headers.get("authorization");
	if (!header?.startsWith("Bearer ")) throw new AuthError("missing bearer token");
	const token = header.slice("Bearer ".length).trim();

	if (token.startsWith("dev:")) {
		if (!devAuth) throw new AuthError("dev tokens are disabled on this deployment", 403);
		const identity = token.slice("dev:".length);
		if (!identity) throw new AuthError("dev token carries no identity");
		return { identity, canWrite: true };
	}
	if (token.startsWith("read:")) {
		if (!devAuth) throw new AuthError("dev tokens are disabled on this deployment", 403);
		const identity = token.slice("read:".length);
		if (!identity) throw new AuthError("read token carries no identity");
		return { identity, canWrite: false };
	}
	if (oidc) return oidc.authenticate(token);
	throw new AuthError("OIDC authentication is not configured on this deployment", 501);
}
