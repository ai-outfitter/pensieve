import { INSTALL_SCOPES, type CaptureProfile, type CollectorContext, type InstallScope, type RecordKind } from "./types.ts";

/**
 * The install scope is written by the installer into the environment it
 * controls, never guessed by the collector at run time. A collector that
 * cannot prove it was installed at managed scope reports the weaker scope it
 * actually has — reporting an advisory installation as authoritative is
 * forbidden. CLC-001.2.3, CLC-001.2.4.
 */
export function installScope(env = Bun.env): InstallScope {
	const declared = env.PENSIEVE_INSTALL_SCOPE as InstallScope | undefined;
	return declared && INSTALL_SCOPES.includes(declared) ? declared : "session";
}

/**
 * `unsupported` is declared by the collector, never inferred here from a
 * harness name. Capability follows the event surface a collector actually
 * uses, so only the collector can state it — and a new collector must not
 * require an edit to shared code to describe itself. CLC-001.1.7, CLC-001.7.2,
 * CLC-001.7.4.
 */
export function profileFor(unsupported: RecordKind[], env = Bun.env): CaptureProfile {
	const required = (env.PENSIEVE_REQUIRED_CLASSES ?? "session,tool-call,patch,model-exchange")
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean) as RecordKind[];

	return { name: env.PENSIEVE_PROFILE ?? "agent-authored-changes", required, unsupported };
}

export interface ContextOptions {
	harness: string;
	harnessVersion: string;
	eventSurface: string;
	/** Artifact classes this collector's event surface cannot expose. */
	unsupported: RecordKind[];
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
		profile: profileFor(options.unsupported, env),
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
