import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildContext, clientOptions, effectiveCollectorEnvironment } from "./context.ts";

const directories: string[] = [];
afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const managedDocument = (overrides: Record<string, string> = {}) => ({
	version: 1,
	environment: {
		PENSIEVE_COLLECTOR_REVISION: "a".repeat(40),
		PENSIEVE_ENVIRONMENT: "cluster",
		PENSIEVE_IDENTITY: "system:serviceaccount:agent-example:agent-runtime",
		PENSIEVE_INSTALL_SCOPE: "managed",
		PENSIEVE_POLICY_DIGEST: `sha256:${"b".repeat(64)}`,
		PENSIEVE_PROFILE: "resident-complete-trace-v1",
		PENSIEVE_REQUIRED_CLASSES: "session,transcript,model-exchange,tool-call",
		PENSIEVE_SINK: "https://pensieve.example.test",
		PENSIEVE_SPOOL: "/workspace/.pensieve/spool",
		PENSIEVE_STATE: "/workspace/.pensieve/state",
		PENSIEVE_TOKEN_FILE: "/var/run/agent/pensieve/token",
		...overrides,
	},
});

const configFile = (value: unknown) => {
	const directory = mkdtempSync(join(tmpdir(), "pensieve-managed-"));
	directories.push(directory);
	const file = join(directory, "managed-config.json");
	writeFileSync(file, JSON.stringify(value));
	return file;
};

describe("managed collector configuration", () => {
	test("operator-owned values override mutable profile environment", () => {
		const file = configFile(managedDocument());
		const effective = effectiveCollectorEnvironment({
			PENSIEVE_INSTALL_SCOPE: "session",
			PENSIEVE_SINK: "https://attacker.invalid",
			PENSIEVE_TOKEN: "static-profile-token",
		}, file);
		expect(effective.PENSIEVE_INSTALL_SCOPE).toBe("managed");
		expect(effective.PENSIEVE_SINK).toBe("https://pensieve.example.test");
		expect(effective.PENSIEVE_TOKEN_FILE).toBe("/var/run/agent/pensieve/token");

		const context = buildContext({
			harness: "pi", harnessVersion: "test", eventSurface: "extension:in-process",
			unsupported: [], run: "run-1", cwd: "/workspace",
		}, effective);
		expect(context.install_scope).toBe("managed");
		expect(context.collector_revision).toBe("a".repeat(40));
		expect(context.profile.name).toBe("resident-complete-trace-v1");
		expect(clientOptions(effective)).toMatchObject({
			sink: "https://pensieve.example.test",
			tokenFile: "/var/run/agent/pensieve/token",
		});
	});

	test("fails closed for a malformed managed document", () => {
		const file = configFile(managedDocument({ PENSIEVE_INSTALL_SCOPE: "session" }));
		expect(() => effectiveCollectorEnvironment({}, file)).toThrow("install scope must be managed");
	});

	test("rejects unrecognized environment injection", () => {
		const file = configFile(managedDocument({ NODE_OPTIONS: "--require=/tmp/override" }));
		expect(() => effectiveCollectorEnvironment({}, file)).toThrow("invalid environment key NODE_OPTIONS");
	});
});
