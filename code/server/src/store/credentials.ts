import { readFile } from "node:fs/promises";

export interface S3Credentials {
	accessKeyId: string;
	secretAccessKey: string;
	sessionToken?: string;
}

export interface CredentialProvider {
	getCredentials(): Promise<S3Credentials>;
}

export interface CredentialSourceOptions {
	accessKeyId?: string;
	secretAccessKey?: string;
	sessionToken?: string;
	roleArn?: string;
	webIdentityTokenFile?: string;
	roleSessionName?: string;
	region: string;
}

type Fetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface WebIdentityCredentialProviderOptions {
	roleArn: string;
	tokenFile: string;
	region: string;
	roleSessionName?: string;
	stsEndpoint?: string;
	refreshBeforeMs?: number;
	fetch?: Fetch;
	readToken?: (path: string) => Promise<string>;
	now?: () => Date;
}

interface CachedCredentials {
	credentials: S3Credentials;
	expiresAt: number;
}

const DEFAULT_REFRESH_BEFORE_MS = 5 * 60 * 1000;

export class StaticCredentialProvider implements CredentialProvider {
	constructor(private readonly credentials: S3Credentials) {}

	async getCredentials(): Promise<S3Credentials> {
		return this.credentials;
	}
}

/**
 * Resolve temporary credentials with STS's unsigned web-identity operation.
 * The projected token is intentionally read inside refresh(), never cached.
 */
export class WebIdentityCredentialProvider implements CredentialProvider {
	private cached?: CachedCredentials;
	private refreshing?: Promise<S3Credentials>;
	private readonly fetch: Fetch;
	private readonly readToken: (path: string) => Promise<string>;
	private readonly now: () => Date;
	private readonly refreshBeforeMs: number;

	constructor(private readonly options: WebIdentityCredentialProviderOptions) {
		this.fetch = options.fetch ?? fetch;
		this.readToken = options.readToken ?? ((path) => readFile(path, "utf8"));
		this.now = options.now ?? (() => new Date());
		this.refreshBeforeMs = options.refreshBeforeMs ?? DEFAULT_REFRESH_BEFORE_MS;
	}

	async getCredentials(): Promise<S3Credentials> {
		if (this.cached && this.cached.expiresAt - this.now().getTime() > this.refreshBeforeMs) {
			return this.cached.credentials;
		}
		if (!this.refreshing) {
			this.refreshing = this.refresh().finally(() => {
				this.refreshing = undefined;
			});
		}
		return this.refreshing;
	}

	private async refresh(): Promise<S3Credentials> {
		const token = (await this.readToken(this.options.tokenFile)).trim();
		if (!token) throw new Error(`web identity token file is empty: ${this.options.tokenFile}`);

		const body = new URLSearchParams({
			Action: "AssumeRoleWithWebIdentity",
			Version: "2011-06-15",
			RoleArn: this.options.roleArn,
			RoleSessionName: this.options.roleSessionName ?? `pensieve-${process.pid}`,
			WebIdentityToken: token,
		});
		const endpoint = this.options.stsEndpoint ?? `https://sts.${this.options.region}.amazonaws.com`;
		const response = await this.fetch(endpoint, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded; charset=utf-8" },
			body,
		});
		const xml = await response.text();
		if (!response.ok) {
			const message = xmlValue(xml, "Message");
			throw new Error(`STS AssumeRoleWithWebIdentity failed: ${response.status}${message ? ` ${message}` : ""}`);
		}

		const accessKeyId = xmlValue(xml, "AccessKeyId");
		const secretAccessKey = xmlValue(xml, "SecretAccessKey");
		const sessionToken = xmlValue(xml, "SessionToken");
		const expiration = xmlValue(xml, "Expiration");
		const expiresAt = expiration ? Date.parse(expiration) : Number.NaN;
		if (!accessKeyId || !secretAccessKey || !sessionToken || !Number.isFinite(expiresAt)) {
			throw new Error("STS AssumeRoleWithWebIdentity returned incomplete credentials");
		}

		const credentials = { accessKeyId, secretAccessKey, sessionToken };
		this.cached = { credentials, expiresAt };
		return credentials;
	}
}

export function createCredentialProvider(options: CredentialSourceOptions): CredentialProvider {
	const hasAccessKey = Boolean(options.accessKeyId);
	const hasSecretKey = Boolean(options.secretAccessKey);
	if (hasAccessKey !== hasSecretKey) {
		throw new Error("static S3 credentials are incomplete; access key ID and secret access key are both required");
	}
	if (hasAccessKey && hasSecretKey) {
		return new StaticCredentialProvider({
			accessKeyId: options.accessKeyId as string,
			secretAccessKey: options.secretAccessKey as string,
			sessionToken: options.sessionToken,
		});
	}

	const hasRoleArn = Boolean(options.roleArn);
	const hasTokenFile = Boolean(options.webIdentityTokenFile);
	if (hasRoleArn !== hasTokenFile) {
		throw new Error("web identity credentials are incomplete; AWS_ROLE_ARN and AWS_WEB_IDENTITY_TOKEN_FILE are both required");
	}
	if (hasRoleArn && hasTokenFile) {
		return new WebIdentityCredentialProvider({
			roleArn: options.roleArn as string,
			tokenFile: options.webIdentityTokenFile as string,
			roleSessionName: options.roleSessionName,
			region: options.region,
		});
	}

	throw new Error("no S3 credentials configured; set the static credential pair or web identity variables");
}

function xmlValue(xml: string, tag: string): string | undefined {
	const value = new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(xml)?.[1];
	return value ? decodeXml(value) : undefined;
}

function decodeXml(value: string): string {
	return value
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&quot;", '"')
		.replaceAll("&apos;", "'")
		.replaceAll("&amp;", "&");
}
