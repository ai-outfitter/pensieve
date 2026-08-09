import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { CommitInfo } from "./types.ts";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string | null> {
	try {
		const { stdout } = await execFileAsync("git", args, { cwd });
		return stdout.trim();
	} catch {
		return null;
	}
}

export async function head(cwd: string): Promise<string | null> {
	return git(cwd, ["rev-parse", "HEAD"]);
}

/**
 * `patch_id` is the durable identity of a change. A rebased or cherry-picked
 * commit carrying the same delta resolves to the same value, which is what
 * lets evidence survive history rewriting. CLC-001.3.2, SRV-001.4.2.
 */
export async function patchId(cwd: string, sha: string): Promise<string> {
	try {
		const { stdout } = await execFileAsync("sh", ["-c", 'git show "$1" | git patch-id --stable', "sh", sha], { cwd });
		return stdout.trim().split(/\s+/)[0] ?? "";
	} catch {
		return "";
	}
}

export async function commitInfo(cwd: string, sha: string): Promise<CommitInfo | null> {
	// Tree and parents come from one `git show`, not two round trips.
	const summary = await git(cwd, ["show", "-s", "--format=%T %P", sha]);
	if (!summary) return null;
	const [tree, ...parents] = summary.split(/\s+/).filter(Boolean);
	if (!tree) return null;
	return { sha, tree, parents, patch_id: await patchId(cwd, sha) };
}
