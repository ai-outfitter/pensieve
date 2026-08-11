import { describe, expect, test } from "bun:test";
import {
	createCredentialProvider,
	StaticCredentialProvider,
	WebIdentityCredentialProvider,
} from "./credentials.ts";

const REGION = "us-east-1";
const ROLE_ARN = "arn:aws:iam::123456789012:role/pensieve";

describe("S3 credential provider selection", () => {
	test("static credentials win when both sources are configured", async () => {
		const provider = createCredentialProvider({
			region: REGION,
			accessKeyId: "static-id",
			secretAccessKey: "static-secret",
			roleArn: ROLE_ARN,
			webIdentityTokenFile: "/var/run/secrets/eks.amazonaws.com/serviceaccount/token",
		});

		expect(provider).toBeInstanceOf(StaticCredentialProvider);
		expect(await provider.getCredentials()).toEqual({
			accessKeyId: "static-id",
			secretAccessKey: "static-secret",
			sessionToken: undefined,
		});
	});

	test("web identity is selected when it is the only complete source", () => {
		const provider = createCredentialProvider({
			region: REGION,
			roleArn: ROLE_ARN,
			webIdentityTokenFile: "/token",
		});
		expect(provider).toBeInstanceOf(WebIdentityCredentialProvider);
	});

	test("neither source and a partial static source are errors", () => {
		expect(() => createCredentialProvider({ region: REGION })).toThrow("no S3 credentials configured");
		expect(() => createCredentialProvider({ region: REGION, accessKeyId: "only-half" })).toThrow(
			"static S3 credentials are incomplete",
		);
	});
});

describe("web identity credential refresh", () => {
	test("uses an unsigned STS POST, caches valid credentials, and rereads the token on early refresh", async () => {
		let now = new Date("2026-08-11T12:00:00.000Z");
		let token = "projected-token-one";
		let reads = 0;
		const requests: Array<{ url: string; authorization: string | null; body: URLSearchParams }> = [];
		let responseNumber = 0;
		const provider = new WebIdentityCredentialProvider({
			roleArn: ROLE_ARN,
			tokenFile: "/projected/token",
			region: REGION,
			stsEndpoint: "https://sts.stub.test",
			now: () => now,
			readToken: async (path) => {
				expect(path).toBe("/projected/token");
				reads += 1;
				return token;
			},
			fetch: async (input, init) => {
				responseNumber += 1;
				const headers = new Headers(init?.headers);
				const body = new URLSearchParams(String(init?.body));
				requests.push({ url: String(input), authorization: headers.get("authorization"), body });
				return stsResponse({
					accessKeyId: `temporary-id-${responseNumber}`,
					secretAccessKey: `temporary-secret-${responseNumber}`,
					sessionToken: `session-token-${responseNumber}`,
					expiration: new Date(now.getTime() + 60 * 60 * 1000).toISOString(),
				});
			},
		});

		expect((await provider.getCredentials()).accessKeyId).toBe("temporary-id-1");
		now = new Date(now.getTime() + 54 * 60 * 1000);
		expect((await provider.getCredentials()).accessKeyId).toBe("temporary-id-1");
		expect(reads).toBe(1);

		token = "projected-token-two";
		now = new Date(now.getTime() + 2 * 60 * 1000);
		expect((await provider.getCredentials()).accessKeyId).toBe("temporary-id-2");
		expect(reads).toBe(2);
		expect(requests).toHaveLength(2);
		expect(requests[0]?.url).toBe("https://sts.stub.test");
		expect(requests[0]?.authorization).toBeNull();
		expect(requests[0]?.body.get("Action")).toBe("AssumeRoleWithWebIdentity");
		expect(requests[0]?.body.get("RoleArn")).toBe(ROLE_ARN);
		expect(requests[0]?.body.get("WebIdentityToken")).toBe("projected-token-one");
		expect(requests[1]?.body.get("WebIdentityToken")).toBe("projected-token-two");
	});
});

function stsResponse(credentials: {
	accessKeyId: string;
	secretAccessKey: string;
	sessionToken: string;
	expiration: string;
}): Response {
	return new Response(
		`<AssumeRoleWithWebIdentityResponse><AssumeRoleWithWebIdentityResult><Credentials>
			<AccessKeyId>${credentials.accessKeyId}</AccessKeyId>
			<SecretAccessKey>${credentials.secretAccessKey}</SecretAccessKey>
			<SessionToken>${credentials.sessionToken}</SessionToken>
			<Expiration>${credentials.expiration}</Expiration>
		</Credentials></AssumeRoleWithWebIdentityResult></AssumeRoleWithWebIdentityResponse>`,
	);
}
