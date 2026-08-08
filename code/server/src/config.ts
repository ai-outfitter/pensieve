export interface Config {
	port: number;
	sinkId: string;
	signingKey?: string;
	indexPath: string;
	retentionFloorDays: number;
	/** Dev auth accepts `Authorization: Bearer dev:<identity>`. Never enable in production. */
	devAuth: boolean;
	store:
		| { kind: "s3"; endpoint: string; bucket: string; region: string; accessKeyId: string; secretAccessKey: string }
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
	const s3Keys = [
		"PENSIEVE_S3_ENDPOINT",
		"PENSIEVE_S3_BUCKET",
		"PENSIEVE_S3_ACCESS_KEY_ID",
		"PENSIEVE_S3_SECRET_ACCESS_KEY",
	] as const;
	const present = s3Keys.filter((key) => env[key]);
	const declared = env.PENSIEVE_STORE;

	if (declared === "filesystem") {
		return { kind: "filesystem", root: env.PENSIEVE_FS_ROOT ?? "/var/lib/pensieve/objects" };
	}
	if (declared === "s3" || present.length > 0) {
		const missing = s3Keys.filter((key) => !env[key]);
		if (missing.length > 0) {
			throw new Error(`S3 store selected but incomplete; missing: ${missing.join(", ")}`);
		}
		return {
			kind: "s3",
			endpoint: env.PENSIEVE_S3_ENDPOINT as string,
			bucket: env.PENSIEVE_S3_BUCKET as string,
			region: env.PENSIEVE_S3_REGION ?? "us-east-1",
			accessKeyId: env.PENSIEVE_S3_ACCESS_KEY_ID as string,
			secretAccessKey: env.PENSIEVE_S3_SECRET_ACCESS_KEY as string,
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
