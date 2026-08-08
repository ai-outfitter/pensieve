#!/usr/bin/env bun
/**
 * Codex collector.
 *
 * Installed as managed lifecycle hooks in `/etc/codex/`. Codex is the only
 * harness of the three with an explicit answer to bypass: managed hooks from a
 * system, MDM, or `requirements.toml` source are trusted by policy and cannot
 * be disabled from the user hook browser, and `allow_managed_hooks_only = true`
 * drops user, project, and plugin hook configuration entirely. CLC-001.2.6.
 *
 * Payload difference from Claude Code: the post-tool field is `tool_response`
 * rather than `tool_output`. Normalizing here is what keeps the emitted records
 * identical across harnesses. CLC-001.1.5.
 *
 * Like Claude Code, Codex hooks never carry the model request or response body,
 * so `model-exchange` is a declared gap. CLC-001.7.2.
 */
import { runHook, type NormalizedEvent } from "@pensieve/collector-core/hook-runner";

interface CodexHookPayload {
	hook_event_name: string;
	session_id: string;
	cwd: string;
	transcript_path?: string;
	turn_id?: string;
	model?: string;
	tool_name?: string;
	tool_input?: unknown;
	tool_response?: unknown;
}

function normalize(payload: CodexHookPayload): NormalizedEvent | null {
	const shared = {
		sessionId: payload.session_id,
		cwd: payload.cwd,
		transcriptPath: payload.transcript_path,
	};
	switch (payload.hook_event_name) {
		case "SessionStart":
			return { phase: "session-start", ...shared };
		case "PreToolUse":
			return { phase: "pre-tool", toolName: payload.tool_name, toolInput: payload.tool_input, ...shared };
		case "PostToolUse":
			return {
				phase: "post-tool",
				toolName: payload.tool_name,
				toolInput: payload.tool_input,
				toolOutput: payload.tool_response,
				isError: Boolean((payload.tool_response as { error?: unknown } | undefined)?.error),
				...shared,
			};
		case "SessionEnd":
			return { phase: "session-end", ...shared };
		default:
			return null;
	}
}

const raw = await Bun.stdin.text();
const payload = JSON.parse(raw) as CodexHookPayload;
const event = normalize(payload);

if (event) {
	await runHook(event, {
		harness: "codex",
		harnessVersion: Bun.env.CODEX_VERSION ?? "unknown",
		eventSurface: `hook:${payload.hook_event_name}`,
		argv: Bun.argv.slice(2),
	});
}

process.exit(0);
