import { describe, expect, test } from "bun:test";
import { loadConfig } from "./config.ts";

const S3_BASE = {
	PENSIEVE_STORE: "s3",
	PENSIEVE_S3_ENDPOINT: "https://objects.example.test",
	PENSIEVE_S3_BUCKET: "evidence",
	AWS_REGION: "us-west-2",
};

describe("S3 configuration credentials", () => {
	test("accepts web identity without static credentials", () => {
		const config = loadConfig({
			...S3_BASE,
			AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/pensieve",
			AWS_WEB_IDENTITY_TOKEN_FILE: "/var/run/secrets/eks.amazonaws.com/serviceaccount/token",
		});

		expect(config.store).toEqual({
			kind: "s3",
			endpoint: "https://objects.example.test",
			bucket: "evidence",
			region: "us-west-2",
			accessKeyId: undefined,
			secretAccessKey: undefined,
			roleArn: "arn:aws:iam::123456789012:role/pensieve",
			webIdentityTokenFile: "/var/run/secrets/eks.amazonaws.com/serviceaccount/token",
			roleSessionName: undefined,
		});
	});

	test("rejects a half-specified static pair even when web identity is complete", () => {
		expect(() =>
			loadConfig({
				...S3_BASE,
				PENSIEVE_S3_ACCESS_KEY_ID: "typo-prone-partial-config",
				AWS_ROLE_ARN: "arn:aws:iam::123456789012:role/pensieve",
				AWS_WEB_IDENTITY_TOKEN_FILE: "/token",
			}),
		).toThrow("PENSIEVE_S3_SECRET_ACCESS_KEY");
	});

	test("rejects S3 when neither credential source is configured", () => {
		expect(() => loadConfig(S3_BASE)).toThrow("no credentials configured");
	});
});

describe("S3 public endpoint", () => {
	const CREDS = {
		PENSIEVE_S3_ACCESS_KEY_ID: "key",
		PENSIEVE_S3_SECRET_ACCESS_KEY: "secret",
	};

	test("loads PENSIEVE_S3_PUBLIC_ENDPOINT onto the store", () => {
		const config = loadConfig({
			...S3_BASE,
			...CREDS,
			PENSIEVE_S3_PUBLIC_ENDPOINT: "https://objects.public.test",
		});
		expect(config.store).toMatchObject({ kind: "s3", publicEndpoint: "https://objects.public.test" });
	});

	test("a malformed public endpoint is a startup error, not a mid-import 500", () => {
		expect(() =>
			loadConfig({ ...S3_BASE, ...CREDS, PENSIEVE_S3_PUBLIC_ENDPOINT: "objects.public.test" }),
		).toThrow("PENSIEVE_S3_PUBLIC_ENDPOINT is not a URL");
	});
});

describe("OIDC trust configuration", () => {
	test("loads separate resident-writer and GitHub-auditor issuers", () => {
		const trusts = [
			{
				issuer: "https://oidc.eks.example.test/id/cluster",
				audience: "pensieve",
				writeSubjectPattern: "^system:serviceaccount:agent-[a-z0-9-]+:agent-runtime$",
			},
			{
				issuer: "https://token.actions.githubusercontent.com",
				audience: "ai-outfitter-pensieve",
				readSubjectPattern: "^repo:Unsupervisedcom/\\.agents:ref:refs/heads/main$",
			},
		];
		expect(loadConfig({ PENSIEVE_OIDC_TRUSTS: JSON.stringify(trusts) }).oidc).toEqual(trusts);
	});

	test("rejects unanchored, authority-free, and duplicate trusts", () => {
		expect(() => loadConfig({ PENSIEVE_OIDC_TRUSTS: JSON.stringify([{
			issuer: "https://issuer", audience: "pensieve", readSubjectPattern: ".*",
		}]) })).toThrow("must be anchored");
		expect(() => loadConfig({ PENSIEVE_OIDC_TRUSTS: JSON.stringify([{
			issuer: "https://issuer", audience: "pensieve",
		}]) })).toThrow("authorizes neither");
		const trust = { issuer: "https://issuer", audience: "pensieve", readSubjectPattern: "^auditor$" };
		expect(() => loadConfig({ PENSIEVE_OIDC_TRUSTS: JSON.stringify([trust, trust]) })).toThrow("duplicate");
	});

	test("rejects ambiguous JSON and legacy trust configuration", () => {
		expect(() => loadConfig({
			PENSIEVE_OIDC_TRUSTS: JSON.stringify([{
				issuer: "https://issuer", audience: "pensieve", readSubjectPattern: "^auditor$",
			}]),
			PENSIEVE_OIDC_ISSUER: "https://legacy-issuer",
		})).toThrow("cannot be combined");
	});
});
