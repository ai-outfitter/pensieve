import type { CaptureProfile, CollectorContext, InstallScope, RecordKind } from "./types.ts";

const SCOPES: InstallScope[] = ["managed", "launcher", "user", "project", "session"];

/**
 * The install scope is written by the installer into the environment it
 * controls, never guessed by the collector at run time. A collector that
 * cannot prove it was installed at managed scope reports the weaker scope it
 * actually has — reporting an advisory installation as authoritative is
 * forbidden. CLC-001.2.3, CLC-001.2.4.
 */
export function installScope(env = Bun.env): InstallScope {
	const declared = env.PENSIEVE_INSTALL_SCOPE as InstallScope | undefined;
	return declared && SCOPES.includes(declared) ? declared : "session";
}

export function profileFor(harness: string, env = Bun.env): CaptureProfile {
	const required = (env.PENSIEVE_REQUIRED_CLASSES ?? "session,tool-call,patch,model-exchange")
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean) as RecordKind[];

	// Measured, not assumed. Claude Code and Codex hooks never carry the model
	// request or response body, so a profile that requires model-exchange gets a
	// declared gap on those harnesses rather than a transcript standing in for
	// it. Pi exposes before_provider_request, so it has no such gap.
	// CLC-001.7.2.
	const unsupported: RecordKind[] =
		harness === "pi" ? [] : (["model-exchange"] as RecordKind[]);

	return { name: env.PENSIEVE_PROFILE ?? "agent-authored-changes", required, unsupported };
}

export interface ContextOptions {
	harness: string;
	harnessVersion: string;
	eventSurface: string;
	run: string;
	cwd: string;
}

export function buildContext(options: ContextOptions, env = Bun.env): CollectorContext {
	return {
		run: options.run,
		attempt: Number(env.PENSIEVE_ATTEMPT ?? 1),
		identity: env.PENSIEVE_IDENTITY ?? `agent:${options.harness}`,
		environment: env.PENSIEVE_ENVIRONMENT ?? "workstation",
		policy_digest: env.PENSIEVE_POLICY_DIGEST ?? "sha256:unknown",
		install_scope: installScope(env),
		harness: options.harness,
		harness_version: options.harnessVersion,
		event_surface: options.eventSurface,
		profile: profileFor(options.harness, env),
		cwd: options.cwd,
	};
}

export function clientOptions(env = Bun.env) {
	return {
		sink: env.PENSIEVE_SINK ?? "http://localhost:4319",
		token: env.PENSIEVE_TOKEN ?? "",
		spool: env.PENSIEVE_SPOOL ?? "/var/lib/pensieve/spool",
		emergencySink: env.PENSIEVE_EMERGENCY_SINK,
		emergencyToken: env.PENSIEVE_EMERGENCY_TOKEN,
	};
}
