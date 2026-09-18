import { existsSync, readFileSync } from "node:fs";

import { INSTALL_SCOPES, type CaptureProfile, type CollectorContext, type InstallScope, type RecordKind } from "./types.ts";

export const MANAGED_CONFIG_PATH = "/var/run/agent/pensieve/managed-config.json";

const MANAGED_ENVIRONMENT_KEYS = new Set([
	"PENSIEVE_COLLECTOR_REVISION",
	"PENSIEVE_ENVIRONMENT",
	"PENSIEVE_IDENTITY",
	"PENSIEVE_INSTALL_SCOPE",
	"PENSIEVE_MANAGED_CONFIG_FILE",
	"PENSIEVE_POLICY_DIGEST",
	"PENSIEVE_PROFILE",
	"PENSIEVE_REQUIRED_CLASSES",
	"PENSIEVE_SINK",
	"PENSIEVE_SPOOL",
	"PENSIEVE_STATE",
	"PENSIEVE_TOKEN_FILE",
]);

/**
 * The Agent Operator projects this file beside the audience-scoped token. It
 * outranks process/profile environment so a mutable catalog cannot redirect,
 * weaken, or relabel managed capture. A present but malformed document fails
 * launch rather than silently falling back to advisory values.
 */
export function effectiveCollectorEnvironment(
	env: NodeJS.ProcessEnv = process.env,
	managedConfigPath = MANAGED_CONFIG_PATH,
): NodeJS.ProcessEnv {
	if (!existsSync(managedConfigPath)) return env;
	let value: unknown;
	try {
		value = JSON.parse(readFileSync(managedConfigPath, "utf8"));
	} catch (error) {
		throw new Error(`invalid managed Pensieve configuration at ${managedConfigPath}: ${String(error)}`, { cause: error });
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`invalid managed Pensieve configuration at ${managedConfigPath}: document must be an object`);
	}
	const document = value as { version?: unknown; environment?: unknown };
	if (document.version !== 1 || !document.environment || typeof document.environment !== "object"
		|| Array.isArray(document.environment)) {
		throw new Error(`invalid managed Pensieve configuration at ${managedConfigPath}: unsupported shape or version`);
	}
	const managed: Record<string, string> = {};
	for (const [key, entry] of Object.entries(document.environment)) {
		if (!MANAGED_ENVIRONMENT_KEYS.has(key) || typeof entry !== "string" || entry.length === 0) {
			throw new Error(`invalid managed Pensieve configuration at ${managedConfigPath}: invalid environment key ${key}`);
		}
		managed[key] = entry;
	}
	for (const key of [
		"PENSIEVE_COLLECTOR_REVISION", "PENSIEVE_IDENTITY", "PENSIEVE_INSTALL_SCOPE",
		"PENSIEVE_POLICY_DIGEST", "PENSIEVE_PROFILE", "PENSIEVE_REQUIRED_CLASSES",
		"PENSIEVE_SINK", "PENSIEVE_TOKEN_FILE",
	]) {
		if (!managed[key]) throw new Error(`invalid managed Pensieve configuration at ${managedConfigPath}: missing ${key}`);
	}
	if (managed.PENSIEVE_INSTALL_SCOPE !== "managed") {
		throw new Error(`invalid managed Pensieve configuration at ${managedConfigPath}: install scope must be managed`);
	}
	if (managed.PENSIEVE_TOKEN_FILE !== "/var/run/agent/pensieve/token") {
		throw new Error(`invalid managed Pensieve configuration at ${managedConfigPath}: token path is not operator-owned`);
	}
	return { ...env, ...managed };
}

/**
 * The install scope is written by the installer into the environment it
 * controls, never guessed by the collector at run time. A collector that
 * cannot prove it was installed at managed scope reports the weaker scope it
 * actually has — reporting an advisory installation as authoritative is
 * forbidden. CLC-001.2.3, CLC-001.2.4.
 */
export function installScope(env = process.env): InstallScope {
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
export function profileFor(unsupported: RecordKind[], env = process.env): CaptureProfile {
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

export function buildContext(options: ContextOptions, env = process.env): CollectorContext {
	env = effectiveCollectorEnvironment(env);
	return {
		run: options.run,
		attempt: Number(env.PENSIEVE_ATTEMPT ?? 1),
		identity: env.PENSIEVE_IDENTITY ?? `agent:${options.harness}`,
		environment: env.PENSIEVE_ENVIRONMENT ?? "workstation",
		policy_digest: env.PENSIEVE_POLICY_DIGEST ?? "sha256:unknown",
		install_scope: installScope(env),
		harness: options.harness,
		harness_version: options.harnessVersion,
		collector_revision: env.PENSIEVE_COLLECTOR_REVISION ?? "unknown",
		event_surface: options.eventSurface,
		profile: profileFor(options.unsupported, env),
		cwd: options.cwd,
	};
}

export function clientOptions(env = process.env) {
	env = effectiveCollectorEnvironment(env);
	return {
		sink: env.PENSIEVE_SINK ?? "http://localhost:4319",
		token: env.PENSIEVE_TOKEN ?? "",
		tokenFile: env.PENSIEVE_TOKEN_FILE,
		spool: env.PENSIEVE_SPOOL ?? "/var/lib/pensieve/spool",
		emergencySink: env.PENSIEVE_EMERGENCY_SINK,
		emergencyToken: env.PENSIEVE_EMERGENCY_TOKEN,
	};
}
