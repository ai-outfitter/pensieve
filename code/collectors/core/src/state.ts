import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { RecordKind } from "./types.ts";

/**
 * Command hooks are a fresh process per event, so segment state cannot live in
 * memory the way it can inside an in-process extension. It lives in a
 * root-owned state file keyed by session, which is also what lets a segment
 * survive a crashed harness.
 */
export interface SessionSnapshot {
	captured: RecordKind[];
	digests: string[];
	lastHead: string | null;
	startedAt: string;
}

export class SessionState {
	private constructor(
		private readonly path: string,
		private snapshot: SessionSnapshot,
	) {}

	static async open(root: string, sessionId: string): Promise<SessionState> {
		await mkdir(root, { recursive: true });
		const path = join(root, `${sessionId.replace(/[^A-Za-z0-9_-]/g, "_")}.json`);
		const file = Bun.file(path);
		const snapshot: SessionSnapshot = (await file.exists())
			? ((await file.json()) as SessionSnapshot)
			: { captured: [], digests: [], lastHead: null, startedAt: new Date().toISOString() };
		return new SessionState(path, snapshot);
	}

	get captured(): RecordKind[] {
		return this.snapshot.captured;
	}

	get digests(): string[] {
		return this.snapshot.digests;
	}

	get lastHead(): string | null {
		return this.snapshot.lastHead;
	}

	note(kind: RecordKind, digest?: string): void {
		if (!this.snapshot.captured.includes(kind)) this.snapshot.captured.push(kind);
		if (digest) this.snapshot.digests.push(digest);
	}

	setHead(sha: string | null): void {
		this.snapshot.lastHead = sha;
	}

	/** A sealed segment resets; the next one starts immediately. CLC-001.3.3. */
	reset(): void {
		this.snapshot.captured = [];
		this.snapshot.digests = [];
	}

	async save(): Promise<void> {
		await Bun.write(this.path, JSON.stringify(this.snapshot));
	}
}
