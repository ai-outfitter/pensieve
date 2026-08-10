import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app.ts";
import { canonicalize, recordDigest } from "./canonical.ts";
import type { Config } from "./config.ts";

async function app() {
	const root = await mkdtemp(join(tmpdir(), "pensieve-test-"));
	const config: Config = {
		port: 0,
		sinkId: "test.sink",
		indexPath: ":memory:",
		retentionFloorDays: 7,
		devAuth: true,
		store: { kind: "filesystem", root },
	};
	return createApp(config);
}

const BASE = {
	run: "run-1",
	attempt: 1,
	identity: "agent:engineer",
	environment: "workstation",
	policy_digest: "sha256:policy",
	created_at: "2026-08-07T00:00:00.000Z",
};

function commitEvidence(overrides: Record<string, unknown> = {}) {
	return {
		...BASE,
		kind: "commit-evidence",
		sha: "a".repeat(40),
		tree: "b".repeat(40),
		parents: ["c".repeat(40)],
		patch_id: "d".repeat(40),
		segment: [],
		capture: { profile: "default", required: ["tool-call"], captured: ["tool-call"], gaps: [] },
		install_scope: "managed",
		...overrides,
	};
}

async function json<T>(response: Response): Promise<T> {
	return (await response.json()) as T;
}

interface Created {
	digest: string;
	statement: {
		record_digest: string;
		content_digest: string;
		mechanism: string;
		retain_until: string | null;
		lock_verified: boolean;
		conforming: boolean;
	};
}

function post(path: string, body: unknown, token = "dev:agent:engineer") {
	return new Request(`http://sink${path}`, {
		method: "POST",
		headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

describe("canonical serialization", () => {
	// THIS TEST VALIDATES A HARD REQUIREMENT (SRV-001.3.3)
	test("key order does not change the digest", () => {
		expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
		expect(recordDigest({ b: 1, a: 2 })).toBe(recordDigest({ a: 2, b: 1 }));
	});

	// THIS TEST VALIDATES A HARD REQUIREMENT (SRV-001.3.3)
	test("undefined members are dropped, not encoded", () => {
		expect(canonicalize({ a: 1, b: undefined })).toBe('{"a":1}');
	});
});

describe("ingest", () => {
	// THIS TEST VALIDATES A HARD REQUIREMENT (SRV-001.3.6)
	test("a record missing a required field is rejected", async () => {
		const { handle } = await app();
		const response = await handle(post("/v0/records", { kind: "session", run: "r" }));
		expect(response.status).toBe(400);
		expect((await json<{ error: string }>(response)).error).toContain("attempt");
	});

	// THIS TEST VALIDATES A HARD REQUIREMENT (SRV-001.2.4)
	test("a record whose identity differs from the principal is rejected", async () => {
		const { handle } = await app();
		const response = await handle(post("/v0/records", commitEvidence(), "dev:agent:other"));
		expect(response.status).toBe(403);
	});

	// THIS TEST VALIDATES A HARD REQUIREMENT (SRV-001.2.5)
	test("agent work attributed to a human account is rejected", async () => {
		const { handle } = await app();
		const record = commitEvidence({ identity: "user:nick" });
		const response = await handle(post("/v0/records", record, "dev:user:nick"));
		expect(response.status).toBe(403);
	});

	// THIS TEST VALIDATES A HARD REQUIREMENT (CICD-001.6.4)
	test("a read-only principal may not write evidence", async () => {
		const { handle } = await app();
		const response = await handle(post("/v0/records", commitEvidence(), "read:agent:engineer"));
		expect(response.status).toBe(403);
	});

	// THIS TEST VALIDATES A HARD REQUIREMENT (SRV-001.4.5)
	test("an unmet required capture class seals the record failed-evidence", async () => {
		const { handle } = await app();
		const record = commitEvidence({
			capture: { profile: "d", required: ["model-exchange"], captured: [], gaps: ["model-exchange"] },
		});
		const created = await handle(post("/v0/records", record));
		expect(created.status).toBe(201);

		const coverage = await handle(
			new Request(`http://sink/v0/commits/${"a".repeat(40)}`, {
				headers: { authorization: "Bearer read:gate" },
			}),
		);
		const body = await json<{ status: string; covered: boolean }>(coverage);
		expect(body.status).toBe("failed-evidence");
		expect(body.covered).toBe(false);
	});
});

describe("storage statements", () => {
	// THIS TEST VALIDATES A HARD REQUIREMENT (SRV-001.5.9)
	test("a development store cannot prove a lock, so the statement is non-conforming", async () => {
		const { handle } = await app();
		const response = await handle(post("/v0/records", commitEvidence()));
		const { statement } = await json<Created>(response);
		expect(statement.lock_verified).toBe(false);
		expect(statement.retain_until).toBeNull();
		expect(statement.conforming).toBe(false);
	});

	// THIS TEST VALIDATES A HARD REQUIREMENT (SRV-001.5.4)
	test("the statement binds the record digest, content digest, and mechanism", async () => {
		const { handle } = await app();
		const response = await handle(post("/v0/records", commitEvidence()));
		const { digest, statement } = await json<Created>(response);
		expect(statement.record_digest).toBe(digest);
		expect(statement.content_digest).toMatch(/^[0-9a-f]{64}$/);
		expect(statement.mechanism).toBe("filesystem");
	});
});

describe("payload routes", () => {
	test("validates a presign request before consulting the store", async () => {
		const { handle } = await app();
		const response = await handle(post("/v0/payloads/presign", { digest: "nope", size: 1, content_type: "text/plain" }));
		expect(response.status).toBe(400);
	});

	test("does not grant upload capabilities to read-only principals", async () => {
		const { handle } = await app();
		const response = await handle(post(
			"/v0/payloads/presign",
			{ digest: "a".repeat(64), size: 1, content_type: "text/plain" },
			"read:verifier",
		));
		expect(response.status).toBe(403);
	});

	test("reports that the development filesystem store cannot presign", async () => {
		const { handle } = await app();
		const response = await handle(post("/v0/payloads/presign", {
			digest: "a".repeat(64),
			size: 1,
			content_type: "text/plain",
		}));
		expect(response.status).toBe(501);
	});
});

describe("verification", () => {
	// THIS TEST VALIDATES A HARD REQUIREMENT (SRV-001.10.5)
	test("a record read back from the store re-derives its own digest", async () => {
		const instance = await app();
		const response = await instance.handle(post("/v0/records", commitEvidence()));
		const { digest } = await json<Created>(response);
		const record = await instance.sink.readRecord(digest);
		expect(record).not.toBeNull();
		expect(recordDigest(record)).toBe(digest);
	});

	// THIS TEST VALIDATES A HARD REQUIREMENT (SRV-001.10.2)
	test("a range query returns the uncovered set, not a boolean alone", async () => {
		const instance = await app();
		await instance.handle(post("/v0/records", commitEvidence()));
		const result = await instance.sink.rangeCoverage(["a".repeat(40), "e".repeat(40)]);
		expect(result.covered).toBe(false);
		expect(result.uncovered).toEqual(["e".repeat(40)]);
	});

	// THIS TEST VALIDATES A HARD REQUIREMENT (SRV-001.4.10)
	test("a patch-id hit is reported as a derivation match, never as exact", async () => {
		const instance = await app();
		await instance.handle(post("/v0/records", commitEvidence()));
		const matches = instance.sink.coverageByPatchId("d".repeat(40));
		expect(matches).toHaveLength(1);
		expect(matches[0]?.match).toBe("patch-id");
	});
});

describe("landing records", () => {
	function landing(overrides: Record<string, unknown> = {}) {
		return {
			...BASE,
			kind: "landing",
			ref: "refs/heads/main",
			before: "0".repeat(40),
			after: "f".repeat(40),
			forced: false,
			landed: [{ sha: "f".repeat(40), attribution: "run", derivation: "identical" }],
			...overrides,
		};
	}

	// THIS TEST VALIDATES A HARD REQUIREMENT (SRV-001.7.12)
	test("ref creation is accepted with the zero object as before", async () => {
		const { handle } = await app();
		expect((await handle(post("/v0/records", landing()))).status).toBe(201);
	});

	// THIS TEST VALIDATES A HARD REQUIREMENT (SRV-001.7.4)
	test("an exempt attribution that names no rule is rejected", async () => {
		const { handle } = await app();
		const record = landing({ landed: [{ sha: "f".repeat(40), attribution: "exempt" }] });
		const response = await handle(post("/v0/records", record));
		expect(response.status).toBe(400);
		expect((await json<{ error: string }>(response)).error).toContain("exempt");
	});

	// THIS TEST VALIDATES A HARD REQUIREMENT (SRV-001.7.10)
	test("a before that does not match the previous after is a chain break", async () => {
		const instance = await app();
		await instance.handle(post("/v0/records", landing()));
		await instance.handle(
			post("/v0/records", landing({ before: "9".repeat(40), after: "8".repeat(40), created_at: "2026-08-07T01:00:00.000Z" })),
		);
		expect(instance.sink.findings().some((finding) => finding.kind === "chain-break")).toBe(true);
	});
});

describe("collector install scope", () => {
	// THIS TEST VALIDATES A HARD REQUIREMENT (CLC-001.2.4)
	test("a non-managed install scope raises an advisory-collection finding", async () => {
		const instance = await app();
		await instance.handle(post("/v0/records", commitEvidence({ install_scope: "launcher" })));
		expect(instance.sink.findings().some((finding) => finding.kind === "advisory-collection")).toBe(true);
	});

	// THIS TEST VALIDATES A HARD REQUIREMENT (CLC-001.2.4)
	test("a managed install scope raises no finding", async () => {
		const instance = await app();
		await instance.handle(post("/v0/records", commitEvidence({ install_scope: "managed" })));
		expect(instance.sink.findings().some((finding) => finding.kind === "advisory-collection")).toBe(false);
	});
});
