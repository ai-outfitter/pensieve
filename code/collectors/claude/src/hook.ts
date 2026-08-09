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
	/**
	 * Which name Claude Code uses for the post-tool result is NOT settled. This
	 * collector was written against `tool_output`, but the field is plausibly
	 * `tool_response`, as it is in Codex, and no capture of a real payload has
	 * confirmed either. Reading whichever is present costs nothing and is
	 * correct under both — guessing wrong records a tool call with no result,
	 * which is a hollow record that still seals green.
	 *
	 * Replace this with the single real field once a live payload is captured.
	 */
	tool_output?: unknown;
	tool_response?: unknown;
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
			case "PostToolUseFailure": {
				const output = payload.tool_response ?? payload.tool_output;
				return {
					phase: "post-tool",
					toolName: payload.tool_name,
					toolInput: payload.tool_input,
					toolOutput: output,
					// Two independent signals, because neither is confirmed. Whether
					// `PostToolUseFailure` is a real Claude Code event is unverified; if
					// it is not, failures arrive as ordinary PostToolUse and only the
					// payload shape distinguishes them. Marking on either signal is
					// correct if one is right and harmless if both are.
					isError:
						payload.hook_event_name === "PostToolUseFailure" ||
						Boolean((output as { error?: unknown } | undefined)?.error),
					...shared,
				};
			}
			case "SessionEnd":
				return { phase: "session-end", ...shared };
			default:
				return null;
		}
	},
});
