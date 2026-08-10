/**
 * Gaps deliberately left by this happy path:
 * - Harness payloads are synthetic, so Claude Code's unresolved `tool_output`
 *   versus `tool_response` shape is not settled here.
 * - There is no forge, so evidence gates, landing records, and squash-merge
 *   bridging remain untested.
 * - Nothing emits landing or release-bundle records yet.
 */
import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { runHook } from "../collectors/core/src/hook-runner.ts";
import { createApp } from "../server/src/app.ts";
import { sha256Hex } from "../server/src/canonical.ts";
import type { Config } from "../server/src/config.ts";
import { S3Store, type S3StoreOptions } from "../server/src/store/s3.ts";
import { signRequest } from "../server/src/store/sigv4.ts";

const execFileAsync = promisify(execFile);
const endpoint = Bun.env.PENSIEVE_S3_TEST_ENDPOINT;
const integrationTest = endpoint ? test : test.skip;
const GIT_ENV = {
	...process.env,
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_CONFIG_SYSTEM: "/dev/null",
};
process.env.GIT_CONFIG_GLOBAL = "/dev/null";
process.env.GIT_CONFIG_SYSTEM = "/dev/null";

async function git(cwd: string, ...args: string[]): Promise<string> {
	const { stdout } = await execFileAsync(
		"git",
		["-c", "user.email=pensieve@example.test", "-c", "user.name=Pensieve Test", ...args],
		{ cwd, env: GIT_ENV },
	);
	return stdout.trim();
}

async function ensureLockedBucket(options: S3StoreOptions): Promise<void> {
	const url = new URL(`${options.endpoint.replace(/\/$/, "")}/${options.bucket}`);
	const headers = signRequest(
		{
			method: "PUT",
			url,
			headers: { "x-amz-bucket-object-lock-enabled": "true" },
			body: new Uint8Array(),
		},
		{
			accessKeyId: options.accessKeyId,
			secretAccessKey: options.secretAccessKey,
			region: options.region,
			service: "s3",
		},
	);
	const response = await fetch(url, { method: "PUT", headers, body: new Uint8Array() });
	if (!response.ok) throw new Error(`could not create lock-enabled bucket: ${response.status} ${await response.text()}`);
}

async function generateSigningKey(): Promise<string> {
	const pair = (await crypto.subtle.generateKey(
		{ name: "Ed25519" },
		true,
		["sign", "verify"],
	)) as unknown as CryptoKeyPair;
	const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
	return Buffer.from(pkcs8).toString("base64");
}

async function attemptVersionMutation(
	options: S3StoreOptions,
	key: string,
	version: string,
	method: "DELETE" | "PUT",
): Promise<Response> {
	const url = new URL(`${options.endpoint.replace(/\/$/, "")}/${options.bucket}/${key}`);
	url.searchParams.set("versionId", version);
	const body = method === "PUT" ? new TextEncoder().encode("replacement") : undefined;
	const headers = signRequest(
		{ method, url, headers: body ? { "content-type": "application/json" } : {}, body },
		{
			accessKeyId: options.accessKeyId,
			secretAccessKey: options.secretAccessKey,
			region: options.region,
			service: "s3",
		},
	);
	return fetch(url, { method, headers, body });
}

integrationTest("a committed agent session produces sealed evidence discoverable by SHA", async () => {
	const root = await mkdtemp(join(tmpdir(), "pensieve-e2e-"));
	const repo = join(root, "repo");
	const spool = join(root, "spool");
	const state = join(root, "state");
	const bucket = `pensieve-e2e-${crypto.randomUUID()}`;
	const s3: S3StoreOptions = {
		endpoint: endpoint as string,
		bucket,
		region: Bun.env.PENSIEVE_S3_TEST_REGION ?? "us-east-1",
		accessKeyId: Bun.env.PENSIEVE_S3_TEST_ACCESS_KEY_ID ?? "pensieve",
		secretAccessKey: Bun.env.PENSIEVE_S3_TEST_SECRET_ACCESS_KEY ?? "pensieve-dev-secret",
	};
	const envKeys = [
		"PENSIEVE_SINK",
		"PENSIEVE_TOKEN",
		"PENSIEVE_SPOOL",
		"PENSIEVE_STATE",
		"PENSIEVE_IDENTITY",
		"PENSIEVE_INSTALL_SCOPE",
		"PENSIEVE_REQUIRED_CLASSES",
		"PENSIEVE_PROFILE",
	] as const;
	const previousEnv = Object.fromEntries(envKeys.map((key) => [key, Bun.env[key]]));
	let server: ReturnType<typeof Bun.serve> | undefined;

	try {
		await ensureLockedBucket(s3);
		await git(root, "init", "-b", "main", repo);
		await writeFile(join(repo, "tracked.txt"), "baseline\n");
		await git(repo, "add", "tracked.txt");
		await git(repo, "commit", "-m", "baseline");

		const config: Config = {
			port: 0,
			sinkId: "e2e.sink",
			signingKey: await generateSigningKey(),
			indexPath: ":memory:",
			retentionFloorDays: 1,
			devAuth: true,
			store: { kind: "s3", ...s3 },
		};
		const app = await createApp(config);
		server = Bun.serve({ port: 0, fetch: app.handle });

		Object.assign(Bun.env, {
			PENSIEVE_SINK: server.url.origin,
			PENSIEVE_TOKEN: "dev:agent:e2e",
			PENSIEVE_SPOOL: spool,
			PENSIEVE_STATE: state,
			PENSIEVE_IDENTITY: "agent:e2e",
			PENSIEVE_INSTALL_SCOPE: "managed",
			PENSIEVE_REQUIRED_CLASSES: "session,tool-call",
			PENSIEVE_PROFILE: "e2e",
		});

		const hookOptions = {
			harness: "synthetic",
			harnessVersion: "test",
			eventSurface: "synthetic:e2e",
			unsupported: [],
			argv: [],
		};
		const sessionId = `e2e-${crypto.randomUUID()}`;
		await runHook({ phase: "session-start", sessionId, cwd: repo }, hookOptions);
		await runHook(
			{
				phase: "post-tool",
				sessionId,
				cwd: repo,
				toolName: "write",
				toolInput: { path: "tracked.txt" },
				toolOutput: { ok: true },
			},
			hookOptions,
		);

		await writeFile(join(repo, "tracked.txt"), "agent change\n");
		await git(repo, "add", "tracked.txt");
		await git(repo, "commit", "-m", "agent change");
		const sha = await git(repo, "rev-parse", "HEAD");
		await runHook({ phase: "session-end", sessionId, cwd: repo }, hookOptions);

		const coverageResponse = await fetch(`${server.url.origin}/v0/coverage`, {
			method: "POST",
			headers: { authorization: "Bearer read:gate", "content-type": "application/json" },
			body: JSON.stringify({ commits: [sha] }),
		});
		expect(coverageResponse.status).toBe(200);
		const coverage = (await coverageResponse.json()) as {
			covered: boolean;
			entries: Array<{ covered: boolean; match?: string; status?: string; evidence?: string }>;
		};
		expect(coverage.covered).toBe(true);
		expect(coverage.entries).toHaveLength(1);
		expect(coverage.entries[0]).toMatchObject({ covered: true, match: "exact", status: "sealed" });
		const digest = coverage.entries[0]?.evidence;
		expect(digest).toMatch(/^[0-9a-f]{64}$/);
		if (!digest) throw new Error("coverage did not return an evidence digest");

		const key = `records/${digest.slice(0, 2)}/${digest}.json`;
		const store = new S3Store(s3);
		const stored = await store.head(key);
		expect(stored?.version).toBeTruthy();
		if (!stored?.version) throw new Error("stored evidence has no object version");

		const deletion = await attemptVersionMutation(s3, key, stored.version, "DELETE");
		expect(deletion.ok).toBe(false);
		const overwrite = await attemptVersionMutation(s3, key, stored.version, "PUT");
		expect(overwrite.ok).toBe(false);
		const original = await store.get(key);
		expect(original && sha256Hex(original)).toBe(digest);
	} finally {
		server?.stop(true);
		for (const key of envKeys) {
			const value = previousEnv[key];
			if (value === undefined) delete Bun.env[key];
			else Bun.env[key] = value;
		}
		await rm(root, { recursive: true, force: true });
	}
});
