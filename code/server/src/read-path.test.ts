import { describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app.ts";
import type { Config } from "./config.ts";

async function app() {
	const root = await mkdtemp(join(tmpdir(), "pensieve-read-path-"));
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

const AUTH = { authorization: "Bearer dev:agent:test" };
const READ = { authorization: "Bearer read:auditor" };

function transcript(overrides: Record<string, unknown> = {}) {
	return {
		kind: "transcript",
		run: "run-1",
		attempt: 1,
		identity: "agent:test",
		environment: "workstation",
		policy_digest: "unattested:imported",
		created_at: "2026-08-15T10:00:00.000Z",
		harness: "codex",
		provenance: "imported",
		observed: false,
		...overrides,
	};
}

async function post(handle: (r: Request) => Promise<Response>, path: string, body: unknown, headers: Record<string, string> = AUTH) {
	return handle(
		new Request(`https://sink.test${path}`, {
			method: "POST",
			headers: { ...headers, "content-type": "application/json" },
			body: JSON.stringify(body),
		}),
	);
}

describe("payload retrieval", () => {
	// THIS TEST VALIDATES A HARD REQUIREMENT (RTR-001.1.1)
	// YOU MUST NOT MODIFY THIS TEST UNLESS THE REQUIREMENT CHANGES
	test("a payload digest returns the exact bytes with the recorded content type", async () => {
		const { handle } = await app();
		const bytes = '{"sessionId":"readable"}\n';
		const put = await handle(
			new Request("https://sink.test/v0/payloads", {
				method: "POST",
				headers: { ...AUTH, "content-type": "application/x-ndjson" },
				body: bytes,
			}),
		);
		expect(put.status).toBe(201);
		const { digest } = (await put.json()) as { digest: string };

		const got = await handle(new Request(`https://sink.test/v0/payloads/${digest}`, { headers: READ }));
		expect(got.status).toBe(200);
		expect(await got.text()).toBe(bytes);
		expect(got.headers.get("content-type")).toBe("application/x-ndjson");
		expect(got.headers.get("x-pensieve-digest")).toBe(digest);
		// RTR-001.1.4: locator, lock mode, and retain-until in the response.
		// The dev store proves the locator; lock headers need a locking store.
		expect(got.headers.get("x-pensieve-locator")).toContain(digest);
	});

	test("an unknown payload digest is 404, and reading needs no store credentials", async () => {
		const { handle } = await app();
		const got = await handle(new Request(`https://sink.test/v0/payloads/${"0".repeat(64)}`, { headers: READ }));
		expect(got.status).toBe(404);
	});
});

describe("record discovery", () => {
	// THIS TEST VALIDATES A HARD REQUIREMENT (RTR-001.2.1)
	// YOU MUST NOT MODIFY THIS TEST UNLESS THE REQUIREMENT CHANGES
	test("records are enumerable by harness, kind, and time window without any digest in hand", async () => {
		const { handle } = await app();
		for (const [run, harness, at] of [
			["run-a", "codex", "2026-08-15T10:00:00.000Z"],
			["run-b", "pi", "2026-08-15T11:00:00.000Z"],
			["run-c", "codex", "2026-08-16T09:00:00.000Z"],
		] as const) {
			const response = await post(handle, "/v0/records", transcript({ run, harness, created_at: at }));
			expect(response.status).toBe(201);
		}

		const codex = await handle(new Request("https://sink.test/v0/records?harness=codex", { headers: READ }));
		expect(codex.status).toBe(200);
		const codexBody = (await codex.json()) as { records: Array<{ run: string }> };
		expect(codexBody.records.map((row) => row.run)).toEqual(["run-a", "run-c"]);

		const windowed = await handle(
			new Request("https://sink.test/v0/records?harness=codex&since=2026-08-16T00:00:00Z", { headers: READ }),
		);
		expect(((await windowed.json()) as { records: unknown[] }).records).toHaveLength(1);

		// A listing row carries enough to fetch the real record. RTR-001.2.3.
		const first = ((await (await handle(new Request("https://sink.test/v0/records?kind=transcript", { headers: READ }))).json()) as {
			records: Array<{ digest: string }>;
		}).records[0];
		expect(first?.digest).toMatch(/^[0-9a-f]{64}$/);
		const fetched = await handle(new Request(`https://sink.test/v0/records/${first?.digest}`, { headers: READ }));
		expect(fetched.status).toBe(200);
	});

	// THIS TEST VALIDATES A HARD REQUIREMENT (RTR-001.3.4)
	// YOU MUST NOT MODIFY THIS TEST UNLESS THE REQUIREMENT CHANGES
	test("a listing row carries the payload digest and provenance, and filters to observed only", async () => {
		const { handle } = await app();
		const put = await handle(
			new Request("https://sink.test/v0/payloads", {
				method: "POST",
				headers: { ...AUTH, "content-type": "application/x-ndjson" },
				body: '{"observed":"no"}\n',
			}),
		);
		const { digest: payloadDigest, locator } = (await put.json()) as { digest: string; locator: string };
		await post(
			handle,
			"/v0/records",
			transcript({
				run: "imported-run",
				payload: { digest: payloadDigest, media_type: "application/x-ndjson", size: 18, locator },
			}),
		);
		await post(handle, "/v0/records", transcript({ run: "observed-run", provenance: undefined, observed: undefined }));

		const all = (await (await handle(new Request("https://sink.test/v0/records", { headers: READ }))).json()) as {
			records: Array<{ run: string; payload_digest: string | null; provenance: string | null; observed: number }>;
		};
		const imported = all.records.find((row) => row.run === "imported-run");
		// RTR-001.2.3: the row names the payload without a second fetch.
		expect(imported?.payload_digest).toBe(payloadDigest);
		// RTR-001.3.1: backfilled is visible in the listing itself.
		expect(imported?.provenance).toBe("imported");
		expect(imported?.observed).toBe(0);

		const observedOnly = (await (
			await handle(new Request("https://sink.test/v0/records?observed=true", { headers: READ }))
		).json()) as { records: Array<{ run: string }> };
		expect(observedOnly.records.map((row) => row.run)).toEqual(["observed-run"]);
	});

	// THIS TEST VALIDATES A HARD REQUIREMENT (RTR-001.2.4)
	// YOU MUST NOT MODIFY THIS TEST UNLESS THE REQUIREMENT CHANGES
	test("pagination is a stable opaque cursor, not an offset", async () => {
		const { handle } = await app();
		for (let index = 0; index < 5; index += 1) {
			await post(handle, "/v0/records", transcript({ run: `run-${index}`, created_at: `2026-08-15T0${index}:00:00.000Z` }));
		}
		const page1 = (await (await handle(new Request("https://sink.test/v0/records?limit=2", { headers: READ }))).json()) as {
			records: Array<{ run: string }>;
			cursor: string | null;
		};
		expect(page1.records).toHaveLength(2);
		expect(page1.cursor).not.toBeNull();

		// Ingest between pages: keyset paging must not shift what page 2 returns.
		await post(handle, "/v0/records", transcript({ run: "run-early", created_at: "2026-08-15T00:30:00.000Z" }));

		const page2 = (await (
			await handle(new Request(`https://sink.test/v0/records?limit=2&cursor=${page1.cursor}`, { headers: READ }))
		).json()) as { records: Array<{ run: string }> };
		expect(page2.records.map((row) => row.run)).toEqual(["run-2", "run-3"]);

		const garbage = await handle(new Request("https://sink.test/v0/records?cursor=%25%25", { headers: READ }));
		expect(garbage.status).toBe(400);
	});
});
