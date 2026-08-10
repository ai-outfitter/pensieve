import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { PensieveClient } from "./client.ts";
import { CommitWatcher, MemorySegmentStore } from "./segment.ts";
import type { CollectorContext, EvidenceRecord } from "./types.ts";

const execFileAsync = promisify(execFile);
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

async function makeRepo(): Promise<string> {
	const cwd = await mkdtemp(join(tmpdir(), "pensieve-segment-"));
	await git(cwd, "init", "-b", "main");
	await writeFile(join(cwd, "tracked.txt"), "root\n");
	await git(cwd, "add", "tracked.txt");
	await git(cwd, "commit", "-m", "root");
	return cwd;
}

async function commit(cwd: string, contents: string, message: string): Promise<string> {
	await writeFile(join(cwd, "tracked.txt"), contents);
	await git(cwd, "add", "tracked.txt");
	await git(cwd, "commit", "-m", message);
	return git(cwd, "rev-parse", "HEAD");
}

function context(cwd: string): CollectorContext {
	return {
		run: "run-segment",
		attempt: 1,
		identity: "agent:test",
		environment: "test",
		policy_digest: "sha256:test",
		install_scope: "managed",
		harness: "synthetic",
		harness_version: "test",
		event_surface: "test",
		profile: { name: "test", required: ["tool-call"], unsupported: [] },
		cwd,
	};
}

async function fixture() {
	const cwd = await makeRepo();
	const spool = await mkdtemp(join(tmpdir(), "pensieve-segment-spool-"));
	const records: EvidenceRecord[] = [];
	const server = Bun.serve({
		port: 0,
		async fetch(request) {
			records.push((await request.json()) as EvidenceRecord);
			return Response.json({ digest: crypto.randomUUID().replaceAll("-", "").padEnd(64, "0") }, { status: 201 });
		},
	});
	const store = new MemorySegmentStore();
	const client = new PensieveClient({ sink: server.url.origin, token: "dev:agent:test", spool });
	return {
		cwd,
		records,
		store,
		watcher: new CommitWatcher(context(cwd), client, store),
		async cleanup() {
			server.stop(true);
			await Promise.all([
				rm(cwd, { recursive: true, force: true }),
				rm(spool, { recursive: true, force: true }),
			]);
		},
	};
}

describe("CommitWatcher", () => {
	test("seals exactly once per HEAD move and resets the segment", async () => {
		const f = await fixture();
		try {
			await f.watcher.start();
			f.watcher.note("tool-call", "d".repeat(64));
			const sha = await commit(f.cwd, "changed\n", "change");

			expect(await f.watcher.check()).toBe(true);
			expect(await f.watcher.check()).toBe(false);
			const evidence = f.records.filter((record) => record.kind === "commit-evidence");
			expect(evidence).toHaveLength(1);
			expect(evidence[0]?.sha).toBe(sha);
			expect(evidence[0]?.segment).toEqual(["d".repeat(64)]);
			expect(f.store.captured).toEqual([]);
			expect(f.store.digests).toEqual([]);
		} finally {
			await f.cleanup();
		}
	});

	test("emits derivation when an amend replaces the previous HEAD", async () => {
		const f = await fixture();
		try {
			await f.watcher.start();
			const before = await git(f.cwd, "rev-parse", "HEAD");
			await writeFile(join(f.cwd, "tracked.txt"), "amended\n");
			await git(f.cwd, "add", "tracked.txt");
			await git(f.cwd, "commit", "--amend", "-m", "amended root");
			const after = await git(f.cwd, "rev-parse", "HEAD");

			expect(await f.watcher.check()).toBe(true);
			expect(f.records.map((record) => record.kind)).toEqual(["derivation", "commit-evidence"]);
			expect(f.records[0]).toMatchObject({ from: before, to: after, performed_in: "session" });
		} finally {
			await f.cleanup();
		}
	});

	test("finish flushes uncommitted work and resets the segment", async () => {
		const f = await fixture();
		try {
			f.watcher.note("tool-call", "e".repeat(64));
			await f.watcher.finish();

			expect(f.records).toHaveLength(1);
			expect(f.records[0]).toMatchObject({
				kind: "session",
				terminal: true,
				uncommitted: true,
				segment: ["e".repeat(64)],
				captured: ["tool-call"],
			});
			expect(f.store.captured).toEqual([]);
			expect(f.store.digests).toEqual([]);
		} finally {
			await f.cleanup();
		}
	});
});
