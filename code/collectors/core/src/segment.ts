import type { PensieveClient } from "./client.ts";
import { commitInfo, head } from "./git.ts";
import type { CollectorContext, EvidenceRecord, RecordKind } from "./types.ts";

/**
 * A session is a stream of events. Commits partition it. The segment between
 * two commit boundaries is what produced the second commit, and that is the
 * unit a forge gate can check. CLC-001.3.
 */
export class Segment {
	private readonly digests: string[] = [];
	private readonly captured = new Set<RecordKind>();

	constructor(private readonly context: CollectorContext) {}

	base(kind: RecordKind): EvidenceRecord {
		return {
			kind,
			run: this.context.run,
			attempt: this.context.attempt,
			identity: this.context.identity,
			environment: this.context.environment,
			policy_digest: this.context.policy_digest,
			created_at: new Date().toISOString(),
			install_scope: this.context.install_scope,
			harness: this.context.harness,
			harness_version: this.context.harness_version,
			event_surface: this.context.event_surface,
		};
	}

	note(kind: RecordKind, digest?: string): void {
		this.captured.add(kind);
		if (digest) this.digests.push(digest);
	}

	/**
	 * Required classes minus captured ones, plus every class this harness cannot
	 * expose at all. A gap is declared, never inferred from silence.
	 * CLC-001.4.3, CLC-001.4.4.
	 */
	gaps(): RecordKind[] {
		const missing = this.context.profile.required.filter((kind) => !this.captured.has(kind));
		const unsupported = this.context.profile.unsupported.filter((kind) =>
			this.context.profile.required.includes(kind),
		);
		return [...new Set([...missing, ...unsupported])];
	}

	snapshot(): { segment: string[]; captured: RecordKind[] } {
		return { segment: [...this.digests], captured: [...this.captured] };
	}
}

/**
 * Watches HEAD and seals a segment whenever it moves. Deliberately observes
 * git rather than trusting the agent to announce its own commits.
 * CLC-001.1.6.
 */
export class CommitWatcher {
	private lastHead: string | null = null;
	private segment: Segment;

	constructor(
		private readonly context: CollectorContext,
		private readonly client: PensieveClient,
	) {
		this.segment = new Segment(context);
	}

	current(): Segment {
		return this.segment;
	}

	async start(): Promise<void> {
		this.lastHead = await head(this.context.cwd);
	}

	/** Call after any event that could have produced a commit. */
	async check(): Promise<boolean> {
		const now = await head(this.context.cwd);
		if (!now || now === this.lastHead) return false;
		const previous = this.lastHead;
		this.lastHead = now;
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
				...this.segment.base("derivation"),
				from: previous,
				to: sha,
				performed_in: "session",
			});
		}

		const snapshot = this.segment.snapshot();
		const gaps = this.segment.gaps();
		await this.client.submit({
			...this.segment.base("commit-evidence"),
			sha: info.sha,
			tree: info.tree,
			parents: info.parents,
			patch_id: info.patch_id,
			segment: snapshot.segment,
			capture: {
				profile: this.context.profile.name,
				required: this.context.profile.required,
				captured: snapshot.captured,
				gaps,
			},
		});

		// A new segment starts immediately. CLC-001.3.3.
		this.segment = new Segment(this.context);
	}

	/**
	 * Work that never became a commit is still retained, in a terminal segment.
	 * The gating unit is the commit; the retention unit is everything.
	 * CLC-001.3.4, CLC-001.3.5.
	 */
	async finish(): Promise<void> {
		const snapshot = this.segment.snapshot();
		if (snapshot.segment.length === 0 && snapshot.captured.length === 0) return;
		await this.client.submit({
			...this.segment.base("session"),
			terminal: true,
			uncommitted: true,
			segment: snapshot.segment,
			captured: snapshot.captured,
		});
	}
}
