import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PensieveClient } from "./client.ts";
import type { EvidenceRecord } from "./types.ts";

const received: string[] = [];
let accepting = false;

const server = Bun.serve({
	port: 0,
	async fetch(request) {
		if (!accepting) return new Response("sink down", { status: 503 });
		const record = (await request.json()) as EvidenceRecord;
		received.push(String(record.marker));
		return Response.json({ digest: "0".repeat(64) }, { status: 201 });
	},
});

afterAll(() => server.stop(true));

function record(marker: string): EvidenceRecord {
	return {
		kind: "session",
		run: "r",
		attempt: 1,
		identity: "agent:test",
		environment: "test",
		policy_digest: "sha256:p",
		created_at: new Date().toISOString(),
		install_scope: "managed",
		harness: "test",
		marker,
	};
}

describe("delivery", () => {
	// THIS TEST VALIDATES A HARD REQUIREMENT (CLC-001.6.2, CLC-001.6.3)
	test("records are never dropped, and a recovery delivers them oldest-first", async () => {
		const spool = await mkdtemp(join(tmpdir(), "pensieve-spool-"));
		const client = new PensieveClient({ sink: server.url.origin, token: "dev:agent:test", spool });

		accepting = false;
		expect((await client.submit(record("a"))).delivered).toBe(false);
		expect((await client.submit(record("b"))).delivered).toBe(false);
		expect(received).toHaveLength(0);

		// A submission that arrives after the sink recovers must not overtake the
		// two records already waiting.
		accepting = true;
		const third = await client.submit(record("c"));
		expect(third.delivered).toBe(true);
		expect(received).toEqual(["a", "b", "c"]);

		expect((await client.flush()).remaining).toBe(0);
	});
});
