export interface Config {
	port: number;
	sinkId: string;
	signingKey?: string;
	indexPath: string;
	retentionFloorDays: number;
	/** Dev auth accepts `Authorization: Bearer dev:<identity>`. Never enable in production. */
	devAuth: boolean;
	store:
		| {
				kind: "s3";
				endpoint: string;
				/**
				 * Externally reachable S3 endpoint that presigned URLs are signed
				 * against, when the internal endpoint is not routable from the
				 * uploader. Unset means presigns use `endpoint`.
				 */
				publicEndpoint?: string;
				bucket: string;
				region: string;
				accessKeyId?: string;
				secretAccessKey?: string;
				roleArn?: string;
				webIdentityTokenFile?: string;
				roleSessionName?: string;
			}
		| { kind: "filesystem"; root: string };
}

function int(value: string | undefined, fallback: number): number {
	const parsed = Number(value);
	return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Choose the backend explicitly.
 *
 * Inferring "S3 if the S3 variables happen to be set" means one misspelled
 * variable silently downgrades a production deployment to the development
 * store, which signs no lock and marks everything non-conforming — a failure
 * that is quiet exactly where it matters. A partial S3 configuration is a
 * startup error instead.
 */
function loadStore(env: Record<string, string | undefined>): Config["store"] {
	const storeKeys = ["PENSIEVE_S3_ENDPOINT", "PENSIEVE_S3_BUCKET"] as const;
	const staticKeys = ["PENSIEVE_S3_ACCESS_KEY_ID", "PENSIEVE_S3_SECRET_ACCESS_KEY"] as const;
	const webIdentityKeys = ["AWS_ROLE_ARN", "AWS_WEB_IDENTITY_TOKEN_FILE"] as const;
	// Generic AWS variables do not select S3 by themselves: an IRSA-enabled
	// service account can be used for unrelated AWS APIs. The explicit store
	// declaration or a Pensieve-specific S3 variable still selects this backend.
	const present = [...storeKeys, ...staticKeys].filter((key) => env[key]);
	const declared = env.PENSIEVE_STORE;

	if (declared === "filesystem") {
		return { kind: "filesystem", root: env.PENSIEVE_FS_ROOT ?? "/var/lib/pensieve/objects" };
	}
	if (declared === "s3" || present.length > 0) {
		const missing = storeKeys.filter((key) => !env[key]);
		if (missing.length > 0) {
			throw new Error(`S3 store selected but incomplete; missing: ${missing.join(", ")}`);
		}
		const staticPresent = staticKeys.filter((key) => env[key]);
		if (staticPresent.length === 1) {
			const missingStatic = staticKeys.filter((key) => !env[key]);
			throw new Error(`S3 static credentials incomplete; missing: ${missingStatic.join(", ")}`);
		}
		const webIdentityPresent = webIdentityKeys.filter((key) => env[key]);
		if (staticPresent.length === 0 && webIdentityPresent.length === 1) {
			const missingWebIdentity = webIdentityKeys.filter((key) => !env[key]);
			throw new Error(`S3 web identity incomplete; missing: ${missingWebIdentity.join(", ")}`);
		}
		if (staticPresent.length === 0 && webIdentityPresent.length === 0) {
			throw new Error(
				"S3 store selected but no credentials configured; set PENSIEVE_S3_ACCESS_KEY_ID/PENSIEVE_S3_SECRET_ACCESS_KEY or AWS_ROLE_ARN/AWS_WEB_IDENTITY_TOKEN_FILE",
			);
		}
		// A malformed public endpoint would otherwise surface as a 500 on the
		// first oversized payload, deep into an import run — the same quiet
		// failure the explicit store selection above exists to prevent.
		if (env.PENSIEVE_S3_PUBLIC_ENDPOINT !== undefined) {
			try {
				new URL(env.PENSIEVE_S3_PUBLIC_ENDPOINT);
			} catch {
				throw new Error(`PENSIEVE_S3_PUBLIC_ENDPOINT is not a URL: "${env.PENSIEVE_S3_PUBLIC_ENDPOINT}"`);
			}
		}
		return {
			kind: "s3",
			endpoint: env.PENSIEVE_S3_ENDPOINT as string,
			publicEndpoint: env.PENSIEVE_S3_PUBLIC_ENDPOINT,
			bucket: env.PENSIEVE_S3_BUCKET as string,
			region: env.PENSIEVE_S3_REGION ?? env.AWS_REGION ?? "us-east-1",
			accessKeyId: env.PENSIEVE_S3_ACCESS_KEY_ID,
			secretAccessKey: env.PENSIEVE_S3_SECRET_ACCESS_KEY,
			roleArn: env.AWS_ROLE_ARN,
			webIdentityTokenFile: env.AWS_WEB_IDENTITY_TOKEN_FILE,
			roleSessionName: env.AWS_ROLE_SESSION_NAME,
		};
	}
	if (declared) throw new Error(`unknown PENSIEVE_STORE "${declared}"`);
	return { kind: "filesystem", root: env.PENSIEVE_FS_ROOT ?? "/var/lib/pensieve/objects" };
}

export function loadConfig(env: Record<string, string | undefined> = Bun.env): Config {
	return {
		port: int(env.PORT, 4319),
		sinkId: env.PENSIEVE_SINK_ID ?? "pensieve.local",
		signingKey: env.PENSIEVE_SIGNING_KEY,
		indexPath: env.PENSIEVE_INDEX ?? ":memory:",
		retentionFloorDays: int(env.PENSIEVE_RETENTION_FLOOR_DAYS, 7),
		devAuth: env.PENSIEVE_DEV_AUTH === "1",
		store: loadStore(env),
	};
}
