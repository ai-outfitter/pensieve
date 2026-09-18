import { beforeAll, describe, expect, test } from "bun:test";
import { authenticate, OidcAuthenticator } from "./auth.ts";

const issuer = "https://kubernetes.default.svc";
const audience = "pensieve.aioutfitter.com";
const kid = "ocean-test-key";
let privateKey: CryptoKey;
let publicJwk: Record<string, unknown>;

beforeAll(async () => {
	const pair = await crypto.subtle.generateKey(
		{ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
		true,
		["sign", "verify"],
	);
	privateKey = pair.privateKey;
	publicJwk = { ...(await crypto.subtle.exportKey("jwk", pair.publicKey)), kid, alg: "RS256", use: "sig" };
});

function encoded(value: unknown) {
	return Buffer.from(JSON.stringify(value)).toString("base64url");
}

async function jwt(overrides: Record<string, unknown> = {}) {
	const header = encoded({ alg: "RS256", kid, typ: "JWT" });
	const claims = encoded({
		iss: issuer,
		aud: audience,
		sub: "system:serviceaccount:agent-ncrmro-luce:agent-runtime",
		exp: Math.floor(Date.now() / 1000) + 300,
		...overrides,
	});
	const signature = await crypto.subtle.sign(
		{ name: "RSASSA-PKCS1-v1_5" },
		privateKey,
		new TextEncoder().encode(`${header}.${claims}`),
	);
	return `${header}.${claims}.${Buffer.from(signature).toString("base64url")}`;
}

function authenticator(readSubjectPattern?: string) {
	const fetcher = (async (input) => {
		if (String(input).endsWith("/.well-known/openid-configuration")) {
			return Response.json({ issuer, jwks_uri: `${issuer}/openid/v1/jwks` });
		}
		if (String(input) === `${issuer}/openid/v1/jwks`) return Response.json({ keys: [publicJwk] });
		return new Response("not found", { status: 404 });
	}) as typeof fetch;
	return new OidcAuthenticator({
		issuer,
		audience,
		writeSubjectPattern: "^system:serviceaccount:agent-[a-z0-9-]+:agent-runtime$",
		readSubjectPattern,
	}, fetcher);
}

describe("production OIDC authentication", () => {
	test("binds an Ocean resident workload identity to the verified subject", async () => {
		// THIS TEST VALIDATES HARD REQUIREMENTS SRV-001.2.2, SRV-001.2.4, AND SRV-001.2.9.
		// YOU MUST NOT MODIFY THIS TEST UNLESS THE REQUIREMENTS CHANGE.
		const token = await jwt();
		await expect(authenticator().authenticate(token)).resolves.toEqual({
			identity: "system:serviceaccount:agent-ncrmro-luce:agent-runtime",
			canWrite: true,
			canRead: false,
		});
	});

	test("grants configured auditor subjects read-only access", async () => {
		const token = await jwt({ sub: "system:serviceaccount:pensieve:auditor" });
		await expect(authenticator("^system:serviceaccount:pensieve:auditor$").authenticate(token)).resolves.toEqual({
			identity: "system:serviceaccount:pensieve:auditor",
			canWrite: false,
			canRead: true,
		});
	});

	test("accepts a separately pinned GitHub auditor issuer without granting writes", async () => {
		const githubIssuer = "https://token.actions.githubusercontent.com";
		const githubAudience = "ai-outfitter-pensieve";
		const fetcher = (async (input) => {
			const url = String(input);
			if (url.endsWith("/.well-known/openid-configuration")) {
				const configuredIssuer = url.startsWith(githubIssuer) ? githubIssuer : issuer;
				return Response.json({ issuer: configuredIssuer, jwks_uri: `${configuredIssuer}/openid/v1/jwks` });
			}
			if (url.endsWith("/openid/v1/jwks")) return Response.json({ keys: [publicJwk] });
			return new Response("not found", { status: 404 });
		}) as typeof fetch;
		const multiple = new OidcAuthenticator([
			{
				issuer, audience,
				writeSubjectPattern: "^system:serviceaccount:agent-[a-z0-9-]+:agent-runtime$",
			},
			{
				issuer: githubIssuer, audience: githubAudience,
				readSubjectPattern: "^repo:Unsupervisedcom/\\.agents:ref:refs/heads/main$",
			},
		], fetcher);
		const token = await jwt({
			iss: githubIssuer,
			aud: githubAudience,
			sub: "repo:Unsupervisedcom/.agents:ref:refs/heads/main",
		});
		await expect(multiple.authenticate(token)).resolves.toEqual({
			identity: "repo:Unsupervisedcom/.agents:ref:refs/heads/main",
			canWrite: false,
			canRead: true,
		});
	});

	test("rejects the wrong audience, expired tokens, and unapproved subjects", async () => {
		await expect(authenticator().authenticate(await jwt({ aud: "another-service" }))).rejects.toThrow("issuer or audience");
		await expect(authenticator().authenticate(await jwt({ exp: 1 }))).rejects.toThrow("expired or not active");
		await expect(authenticator().authenticate(await jwt({ sub: "system:serviceaccount:default:default" }))).rejects.toThrow("not authorized");
	});

	test("rejects a token whose audience array matches multiple trust entries", async () => {
		const fetcher = (async (input) => {
			if (String(input).endsWith("/.well-known/openid-configuration")) {
				return Response.json({ issuer, jwks_uri: `${issuer}/openid/v1/jwks` });
			}
			if (String(input) === `${issuer}/openid/v1/jwks`) return Response.json({ keys: [publicJwk] });
			return new Response("not found", { status: 404 });
		}) as typeof fetch;
		const multiple = new OidcAuthenticator([
			{ issuer, audience, writeSubjectPattern: "^system:serviceaccount:agent-[a-z0-9-]+:agent-runtime$" },
			{ issuer, audience: "pensieve-auditor", readSubjectPattern: "^system:serviceaccount:agent-[a-z0-9-]+:agent-runtime$" },
		], fetcher);
		await expect(multiple.authenticate(await jwt({ aud: [audience, "pensieve-auditor"] })))
			.rejects.toThrow("matches multiple OIDC trust entries");
	});

	test("does not accept read labels as credentials when dev auth is disabled", async () => {
		// THIS TEST VALIDATES A HARD REQUIREMENT (SRV-001.2.10).
		// YOU MUST NOT MODIFY THIS TEST UNLESS THE REQUIREMENT CHANGES.
		const request = new Request("https://pensieve.test/v0/records", {
			headers: { authorization: "Bearer read:anyone" },
		});
		await expect(authenticate(request, false, authenticator())).rejects.toThrow("dev tokens are disabled");
	});
});
