import { PensieveClient } from "./client.ts";
import { buildContext, clientOptions } from "./context.ts";
import { CommitWatcher } from "./segment.ts";
import { SessionState } from "./state.ts";
import type { RecordKind } from "./types.ts";
import { argv, env, stdin } from "node:process";

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
	isError?: boolean;
	transcriptPath?: string;
}

export interface HookOptions {
	harness: string;
	harnessVersion: string;
	eventSurface: string;
	/** Artifact classes this harness cannot expose, declared by the collector. */
	unsupported: RecordKind[];
	argv: string[];
}

/** A `--scope` flag from the installer beats an inherited environment variable. */
function scopeFromArgv(argv: string[]): string | undefined {
	const index = argv.indexOf("--scope");
	return index >= 0 ? argv[index + 1] : undefined;
}

/**
 * The command-hook entry point. It differs from the in-process extension only
 * in where segment state lives: a hook is a fresh process per event, so it
 * uses the file-backed SessionState. Everything else is the shared
 * CommitWatcher.
 */
export async function runHook(raw: NormalizedEvent, options: HookOptions): Promise<void> {
	// A pre-tool event emits nothing — the post event carries both the input and
	// the result, so one record describes the whole call. Return before touching
	// state, rather than reading and rewriting it unchanged.
	if (raw.phase === "pre-tool") return;

	const scope = scopeFromArgv(options.argv);
	if (scope) env.PENSIEVE_INSTALL_SCOPE = scope;

	const context = buildContext(
		{
			harness: options.harness,
			harnessVersion: options.harnessVersion,
			eventSurface: options.eventSurface,
			unsupported: options.unsupported,
			run: raw.sessionId,
			cwd: raw.cwd,
		},
		env,
	);
	const client = new PensieveClient(clientOptions(env));
	const state = await SessionState.open(env.PENSIEVE_STATE ?? "/var/lib/pensieve/state", raw.sessionId);
	const watcher = new CommitWatcher(context, client, state);

	switch (raw.phase) {
		case "session-start": {
			await watcher.start();
			// Record the invocation arguments, including any that disable hooks or
			// extensions. CLC-001.8.1.
			const result = await client.submit({
				...watcher.base("session"),
				session_id: raw.sessionId,
				cwd: raw.cwd,
				argv: options.argv,
				transcript_path: raw.transcriptPath,
			});
			watcher.note("session", result.digest);
			break;
		}
		case "post-tool": {
			const result = await client.submit({
				...watcher.base("tool-call"),
				tool_name: raw.toolName,
				tool_input: raw.toolInput,
				tool_output: raw.toolOutput,
				is_error: raw.isError ?? false,
			});
			watcher.note("tool-call", result.digest);
			await watcher.check();
			break;
		}
		case "session-end": {
			await watcher.check();
			await watcher.finish();
			break;
		}
	}

	await state.save();
}

export interface StdinHookOptions<T> extends Omit<HookOptions, "eventSurface" | "argv"> {
	/** Maps this harness's payload onto the shared event shape. */
	normalize(payload: T): NormalizedEvent | null;
	/** Reads the harness's own name for the event, for `event_surface`. */
	eventName(payload: T): string;
}

/**
 * Read one hook payload from stdin, forward it, exit 0.
 *
 * Both command-hook collectors are this plus a `normalize`. Sharing it is what
 * keeps the wire records identical when a new event or field is added, rather
 * than requiring two files to be edited in step.
 */
export async function runStdinHook<T>(options: StdinHookOptions<T>): Promise<never> {
	stdin.setEncoding("utf8");
	let input = "";
	for await (const chunk of stdin) input += chunk;
	const payload = JSON.parse(input) as T;
	const event = options.normalize(payload);
	if (event) {
		await runHook(event, {
			harness: options.harness,
			harnessVersion: options.harnessVersion,
			unsupported: options.unsupported,
			eventSurface: `hook:${options.eventName(payload)}`,
			argv: argv.slice(2),
		});
	}
	// Exit 0 without JSON: these hooks observe, they never block. Collection that
	// can stop a session is collection an operator will switch off.
	process.exit(0);
}
