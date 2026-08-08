#!/usr/bin/env bun
/**
 * Claude Code collector.
 *
 * Installed as command hooks in `/etc/claude-code/managed-settings.d/`, which
 * has the highest settings precedence and cannot be overridden by user,
 * project, or local settings. That makes this the one collector whose install
 * is authoritative on a workstation the organization owns. CLC-001.2.1.
 *
 * Claude Code hook payloads never carry the model request or response body, so
 * the profile declares `model-exchange` unsupported and any run whose profile
 * requires it seals `failed-evidence`. The transcript is a conversation log,
 * not the API exchange, and must not stand in for it. CLC-001.7.2.
 *
 * Known bypass: `claude --bare` skips hooks entirely. A session that never ran
 * this hook produces no record, and absence is treated as unattested by the
 * sink rather than as clean. CLC-001.8.2.
 */
import { runHook, type NormalizedEvent } from "@pensieve/collector-core/hook-runner";

interface ClaudeHookPayload {
	hook_event_name: string;
	session_id: string;
	cwd: string;
	transcript_path?: string;
	tool_name?: string;
	tool_input?: unknown;
	tool_output?: unknown;
}

function normalize(payload: ClaudeHookPayload): NormalizedEvent | null {
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
		case "PostToolUseFailure":
			return {
				phase: "post-tool",
				toolName: payload.tool_name,
				toolInput: payload.tool_input,
				toolOutput: payload.tool_output,
				...shared,
			};
		case "SessionEnd":
			return { phase: "session-end", ...shared };
		default:
			return null;
	}
}

const raw = await Bun.stdin.text();
const payload = JSON.parse(raw) as ClaudeHookPayload;
const event = normalize(payload);

if (event) {
	await runHook(event, {
		harness: "claude-code",
		harnessVersion: Bun.env.CLAUDE_CODE_VERSION ?? "unknown",
		eventSurface: `hook:${payload.hook_event_name}`,
		argv: Bun.argv.slice(2),
	});
}

// Exit 0 without JSON: this hook observes, it never blocks. Collection that can
// stop a session is collection an operator will switch off.
process.exit(0);
