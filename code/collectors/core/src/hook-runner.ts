import { PensieveClient } from "./client.ts";
import { buildContext, clientOptions } from "./context.ts";
import { commitInfo, head } from "./git.ts";
import { SessionState } from "./state.ts";
import type { CollectorContext, EvidenceRecord, RecordKind } from "./types.ts";

/**
 * The harness-neutral event a collector forwards. Claude Code and Codex both
 * normalize into this shape, so the records they emit are identical and the
 * sink and the gates stay harness-independent. CLC-001.1.5.
 */
export interface NormalizedEvent {
	phase: "session-start" | "pre-tool" | "post-tool" | "session-end";
	sessionId: string;
	cwd: string;
	toolName?: string;
	toolInput?: unknown;
	toolOutput?: unknown;
	transcriptPath?: string;
}

export interface HookOptions {
	harness: string;
	harnessVersion: string;
	eventSurface: string;
	argv: string[];
}

/** A `--scope` flag from the installer beats an inherited environment variable. */
function scopeFromArgv(argv: string[]): string | undefined {
	const index = argv.indexOf("--scope");
	return index >= 0 ? argv[index + 1] : undefined;
}

export async function runHook(raw: NormalizedEvent, options: HookOptions): Promise<void> {
	const scope = scopeFromArgv(options.argv);
	if (scope) Bun.env.PENSIEVE_INSTALL_SCOPE = scope;

	const context = buildContext(
		{
			harness: options.harness,
			harnessVersion: options.harnessVersion,
			eventSurface: options.eventSurface,
			run: raw.sessionId,
			cwd: raw.cwd,
		},
		Bun.env,
	);
	const client = new PensieveClient(clientOptions(Bun.env));
	const state = await SessionState.open(Bun.env.PENSIEVE_STATE ?? "/var/lib/pensieve/state", raw.sessionId);

	const base = (kind: RecordKind): EvidenceRecord => ({
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
		event_surface: context.event_surface,
	});

	switch (raw.phase) {
		case "session-start": {
			state.setHead(await head(raw.cwd));
			// Record the invocation arguments, including any that disable hooks or
			// extensions. CLC-001.8.1.
			const result = await client.submit({
				...base("session"),
				session_id: raw.sessionId,
				cwd: raw.cwd,
				argv: options.argv,
				transcript_path: raw.transcriptPath,
			});
			state.note("session", result.digest);
			break;
		}
		case "pre-tool":
			// Nothing is emitted before a tool runs; the post event carries both the
			// input and the result, so one record describes the whole call.
			break;
		case "post-tool": {
			const result = await client.submit({
				...base("tool-call"),
				tool_name: raw.toolName,
				tool_input: raw.toolInput,
				tool_output: raw.toolOutput,
			});
			state.note("tool-call", result.digest);
			await maybeSeal(raw.cwd, context, client, state);
			break;
		}
		case "session-end": {
			await maybeSeal(raw.cwd, context, client, state);
			if (state.captured.length > 0) {
				// Work that never became a commit is retained in a terminal segment.
				// CLC-001.3.4.
				await client.submit({
					...base("session"),
					terminal: true,
					uncommitted: true,
					segment: state.digests,
					captured: state.captured,
				});
				state.reset();
			}
			break;
		}
	}

	await state.save();
}

/**
 * Observes git rather than trusting the agent to announce its commits.
 * CLC-001.1.6, CLC-001.3.2.
 */
async function maybeSeal(
	cwd: string,
	context: CollectorContext,
	client: PensieveClient,
	state: SessionState,
): Promise<void> {
	const now = await head(cwd);
	if (!now || now === state.lastHead) return;
	const previous = state.lastHead;
	state.setHead(now);

	const info = await commitInfo(cwd, now);
	if (!info) return;

	const shared = {
		run: context.run,
		attempt: context.attempt,
		identity: context.identity,
		environment: context.environment,
		policy_digest: context.policy_digest,
		install_scope: context.install_scope,
		harness: context.harness,
	};

	// History rewritten in-session is recorded where it happened. CLC-001.3.6.
	if (previous && !info.parents.includes(previous)) {
		await client.submit({
			...shared,
			kind: "derivation",
			created_at: new Date().toISOString(),
			from: previous,
			to: now,
			performed_in: "session",
		});
	}

	const missing = context.profile.required.filter((kind) => !state.captured.includes(kind));
	const unsupported = context.profile.unsupported.filter((kind) => context.profile.required.includes(kind));
	const gaps = [...new Set([...missing, ...unsupported])];

	await client.submit({
		...shared,
		kind: "commit-evidence",
		created_at: new Date().toISOString(),
		sha: info.sha,
		tree: info.tree,
		parents: info.parents,
		patch_id: info.patch_id,
		segment: state.digests,
		capture: {
			profile: context.profile.name,
			required: context.profile.required,
			captured: state.captured,
			gaps,
		},
	});
	state.reset();
}
