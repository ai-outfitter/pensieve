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
 * this collector declares `model-exchange` unsupported and any run whose
 * profile requires it seals `failed-evidence`. The transcript is a
 * conversation log, not the API exchange, and must not stand in for it.
 * CLC-001.7.2.
 *
 * Known bypass: `claude --bare` skips hooks entirely. A session that never ran
 * this hook produces no record, and absence is treated as unattested by the
 * sink rather than as clean. CLC-001.8.2.
 */
import { runStdinHook, type NormalizedEvent } from "@pensieve/collector-core/hook-runner";

interface ClaudeHookPayload {
	hook_event_name: string;
	session_id: string;
	cwd: string;
	transcript_path?: string;
	tool_name?: string;
	tool_input?: unknown;
	tool_output?: unknown;
}

await runStdinHook<ClaudeHookPayload>({
	harness: "claude-code",
	harnessVersion: Bun.env.CLAUDE_CODE_VERSION ?? "unknown",
	unsupported: ["model-exchange"],
	eventName: (payload) => payload.hook_event_name,
	normalize(payload): NormalizedEvent | null {
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
					// Both events map to one phase, so the failure must be marked or the
					// record would be indistinguishable from a success. CLC-001.1.5.
					isError: payload.hook_event_name === "PostToolUseFailure",
					...shared,
				};
			case "SessionEnd":
				return { phase: "session-end", ...shared };
			default:
				return null;
		}
	},
});
