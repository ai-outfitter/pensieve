import type { CommitInfo } from "./types.ts";

async function git(cwd: string, args: string[]): Promise<string | null> {
	const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
	const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	return code === 0 ? out.trim() : null;
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
	const proc = Bun.spawn(["sh", "-c", `git show ${sha} | git patch-id --stable`], {
		cwd,
		stdout: "pipe",
		stderr: "ignore",
	});
	const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	if (code !== 0) return "";
	return out.trim().split(/\s+/)[0] ?? "";
}

export async function commitInfo(cwd: string, sha: string): Promise<CommitInfo | null> {
	// Tree and parents come from one `git show`, not two round trips.
	const summary = await git(cwd, ["show", "-s", "--format=%T %P", sha]);
	if (!summary) return null;
	const [tree, ...parents] = summary.split(/\s+/).filter(Boolean);
	if (!tree) return null;
	return { sha, tree, parents, patch_id: await patchId(cwd, sha) };
}
