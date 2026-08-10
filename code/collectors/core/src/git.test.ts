import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { commitInfo, head, patchId } from "./git.ts";

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

async function repo(): Promise<string> {
	const cwd = await mkdtemp(join(tmpdir(), "pensieve-git-"));
	await git(cwd, "init", "-b", "main");
	return cwd;
}

async function commitFile(cwd: string, path: string, contents: string, message: string): Promise<string> {
	await writeFile(join(cwd, path), contents);
	await git(cwd, "add", path);
	await git(cwd, "commit", "-m", message);
	return git(cwd, "rev-parse", "HEAD");
}

describe("git metadata", () => {
	test("patchId survives commit --amend", async () => {
		const cwd = await repo();
		try {
			const before = await commitFile(cwd, "change.txt", "same change\n", "before amend");
			const beforePatch = await patchId(cwd, before);

			await git(cwd, "commit", "--amend", "-m", "after amend");
			const after = await git(cwd, "rev-parse", "HEAD");

			expect(after).not.toBe(before);
			expect(await patchId(cwd, after)).toBe(beforePatch);
			expect(beforePatch).toMatch(/^[0-9a-f]{40}$/);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("patchId is identical after cherry-picking the same change", async () => {
		const cwd = await repo();
		try {
			const root = await commitFile(cwd, "base.txt", "base\n", "root");
			await git(cwd, "switch", "-c", "topic");
			const original = await commitFile(cwd, "change.txt", "portable change\n", "change");

			await git(cwd, "switch", "-c", "other", root);
			await commitFile(cwd, "other.txt", "different history\n", "other branch");
			await git(cwd, "cherry-pick", original);
			const cherryPicked = await git(cwd, "rev-parse", "HEAD");

			expect(cherryPicked).not.toBe(original);
			expect(await patchId(cwd, cherryPicked)).toBe(await patchId(cwd, original));
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("commitInfo reports zero parents for a root and two for a merge", async () => {
		const cwd = await repo();
		try {
			const root = await commitFile(cwd, "base.txt", "base\n", "root");
			expect((await commitInfo(cwd, root))?.parents).toEqual([]);

			await git(cwd, "switch", "-c", "side");
			await commitFile(cwd, "side.txt", "side\n", "side");
			await git(cwd, "switch", "main");
			await commitFile(cwd, "main.txt", "main\n", "main");
			await git(cwd, "merge", "--no-ff", "side", "-m", "merge");
			const merge = await git(cwd, "rev-parse", "HEAD");
			const info = await commitInfo(cwd, merge);

			expect(info?.sha).toBe(merge);
			expect(info?.parents).toHaveLength(2);
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});

	test("head and commitInfo return null outside a git repository", async () => {
		const cwd = await mkdtemp(join(tmpdir(), "pensieve-not-git-"));
		try {
			expect(await head(cwd)).toBeNull();
			expect(await commitInfo(cwd, "a".repeat(40))).toBeNull();
		} finally {
			await rm(cwd, { recursive: true, force: true });
		}
	});
});
