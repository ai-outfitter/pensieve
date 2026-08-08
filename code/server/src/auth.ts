import { AuthError, type Principal } from "./sink.ts";

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
export function authenticate(request: Request, devAuth: boolean): Principal {
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
		const identity = token.slice("read:".length);
		if (!identity) throw new AuthError("read token carries no identity");
		return { identity, canWrite: false };
	}
	throw new AuthError("OIDC token exchange is not implemented on this build", 501);
}
