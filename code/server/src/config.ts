export interface Config {
	port: number;
	sinkId: string;
	signingKey?: string;
	indexPath: string;
	retentionFloorDays: number;
	bundleFreshnessDays: number;
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

export function loadConfig(env: Record<string, string | undefined> = Bun.env): Config {
	const endpoint = env.PENSIEVE_S3_ENDPOINT;
	const bucket = env.PENSIEVE_S3_BUCKET;

	return {
		port: int(env.PORT, 4319),
		sinkId: env.PENSIEVE_SINK_ID ?? "pensieve.local",
		signingKey: env.PENSIEVE_SIGNING_KEY,
		indexPath: env.PENSIEVE_INDEX ?? ":memory:",
		retentionFloorDays: int(env.PENSIEVE_RETENTION_FLOOR_DAYS, 7),
		bundleFreshnessDays: int(env.PENSIEVE_BUNDLE_FRESHNESS_DAYS, 30),
		devAuth: env.PENSIEVE_DEV_AUTH === "1",
		store:
			endpoint && bucket
				? {
						kind: "s3",
						endpoint,
						bucket,
						region: env.PENSIEVE_S3_REGION ?? "us-east-1",
						accessKeyId: env.PENSIEVE_S3_ACCESS_KEY_ID ?? "",
						secretAccessKey: env.PENSIEVE_S3_SECRET_ACCESS_KEY ?? "",
					}
				: { kind: "filesystem", root: env.PENSIEVE_FS_ROOT ?? "/var/lib/pensieve/objects" },
	};
}
