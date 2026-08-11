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
