import type { PensieveClient } from "./client.ts";
import { commitInfo, head } from "./git.ts";
import type { CaptureProfile, CollectorContext, EvidenceRecord, RecordKind } from "./types.ts";

/**
 * Where a segment's accumulated state lives.
 *
 * An in-process extension keeps it in memory. A command hook is a fresh
 * process per event, so it keeps it in a root-owned file. That is the only
 * difference between the two collection models, so it is the only thing that
 * varies — everything downstream of it is shared, which is what makes
 * CLC-001.1.5 ("all collectors emit the same record shapes") true by
 * construction rather than by keeping two copies in step by hand.
 */
export interface SegmentStore {
	readonly captured: RecordKind[];
	readonly digests: string[];
	readonly lastHead: string | null;
	note(kind: RecordKind, digest?: string): void;
	setHead(sha: string | null): void;
	reset(): void;
	save(): Promise<void>;
}

export class MemorySegmentStore implements SegmentStore {
	private capturedKinds: RecordKind[] = [];
	private recordDigests: string[] = [];
	private head: string | null = null;

	get captured(): RecordKind[] {
		return this.capturedKinds;
	}

	get digests(): string[] {
		return this.recordDigests;
	}

	get lastHead(): string | null {
		return this.head;
	}

	note(kind: RecordKind, digest?: string): void {
		if (!this.capturedKinds.includes(kind)) this.capturedKinds.push(kind);
		if (digest) this.recordDigests.push(digest);
	}

	setHead(sha: string | null): void {
		this.head = sha;
	}

	reset(): void {
		this.capturedKinds = [];
		this.recordDigests = [];
	}

	async save(): Promise<void> {}
}

/** Every record from every collector is built here, so none can drift. */
export function baseRecord(context: CollectorContext, kind: RecordKind): EvidenceRecord {
	return {
		kind,
		run: context.run,
		attempt: context.attempt,
		identity: context.identity,
		environment: context.environment,
		policy_digest: context.policy_digest,
		created_at: new Date().toISOString(),
		install_scope: context.install_scope,
		harness: context.harness,
		harness_version: context.harness_version,
		// The event surface actually used, so coverage is computed rather than
		// asserted from documentation. CLC-001.7.4.
		event_surface: context.event_surface,
	};
}

/**
 * Required classes minus captured ones, plus every class this harness cannot
 * expose at all. A gap is declared, never inferred from silence.
 * CLC-001.4.3, CLC-001.4.4.
 */
export function computeGaps(profile: CaptureProfile, captured: readonly RecordKind[]): RecordKind[] {
	const missing = profile.required.filter((kind) => !captured.includes(kind));
	const unsupported = profile.unsupported.filter((kind) => profile.required.includes(kind));
	return [...new Set([...missing, ...unsupported])];
}

/**
 * A session is a stream of events. Commits partition it. The segment between
 * two commit boundaries is what produced the second commit, and that is the
 * unit a forge gate can check. CLC-001.3.
 *
 * Watches HEAD and seals a segment whenever it moves, deliberately observing
 * git rather than trusting the agent to announce its own commits. CLC-001.1.6.
 */
export class CommitWatcher {
	constructor(
		private readonly context: CollectorContext,
		private readonly client: PensieveClient,
		private readonly store: SegmentStore,
	) {}

	base(kind: RecordKind): EvidenceRecord {
		return baseRecord(this.context, kind);
	}

	note(kind: RecordKind, digest?: string): void {
		this.store.note(kind, digest);
	}

	async start(): Promise<void> {
		this.store.setHead(await head(this.context.cwd));
	}

	/** Call after any event that could have produced a commit. */
	async check(): Promise<boolean> {
		const now = await head(this.context.cwd);
		if (!now || now === this.store.lastHead) return false;
		const previous = this.store.lastHead;
		this.store.setHead(now);
		await this.seal(now, previous);
		return true;
	}

	private async seal(sha: string, previous: string | null): Promise<void> {
		const info = await commitInfo(this.context.cwd, sha);
		if (!info) return;

		// An amend or rebase rewrites history rather than adding to it. Record the
		// derivation where it happened. CLC-001.3.6.
		if (previous && !info.parents.includes(previous)) {
			await this.client.submit({
				...this.base("derivation"),
				from: previous,
				to: sha,
				performed_in: "session",
			});
		}

		await this.client.submit({
			...this.base("commit-evidence"),
			sha: info.sha,
			tree: info.tree,
			parents: info.parents,
			patch_id: info.patch_id,
			segment: [...this.store.digests],
			capture: {
				profile: this.context.profile.name,
				required: this.context.profile.required,
				captured: [...this.store.captured],
				gaps: computeGaps(this.context.profile, this.store.captured),
			},
		});

		// A new segment starts immediately. CLC-001.3.3.
		this.store.reset();
	}

	/**
	 * Work that never became a commit is still retained, in a terminal segment.
	 * The gating unit is the commit; the retention unit is everything.
	 * CLC-001.3.4, CLC-001.3.5.
	 */
	async finish(): Promise<void> {
		if (this.store.digests.length === 0 && this.store.captured.length === 0) return;
		await this.client.submit({
			...this.base("session"),
			terminal: true,
			uncommitted: true,
			segment: [...this.store.digests],
			captured: [...this.store.captured],
		});
		this.store.reset();
	}
}
