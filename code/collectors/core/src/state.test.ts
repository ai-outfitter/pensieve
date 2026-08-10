import { describe, expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionState } from "./state.ts";

const root = async () => mkdtemp(join(tmpdir(), "pensieve-state-"));

describe("SessionState.open", () => {
	test("starts a fresh segment when no state file exists", async () => {
		const state = await SessionState.open(await root(), "new-session");
		expect(state.captured).toEqual([]);
		expect(state.lastHead).toBeNull();
	});

	test("reads back a saved segment", async () => {
		const directory = await root();
		const first = await SessionState.open(directory, "kept");
		first.note("session", "digest-a");
		first.setHead("abc123");
		await first.save();

		const second = await SessionState.open(directory, "kept");
		expect(second.captured).toEqual(["session"]);
		expect(second.digests).toEqual(["digest-a"]);
		expect(second.lastHead).toBe("abc123");
	});

	/**
	 * A crash during save leaves a truncated file. Throwing here would stop
	 * collection for the whole session, and these collectors observe rather than
	 * block — so a corrupt segment starts a new one instead.
	 */
	test("starts a fresh segment when the state file is truncated", async () => {
		const directory = await root();
		await writeFile(join(directory, "corrupt.json"), '{"captured": ["session"');

		const state = await SessionState.open(directory, "corrupt");
		expect(state.captured).toEqual([]);
		expect(state.lastHead).toBeNull();
	});

	/** A real I/O failure is not a corrupt segment and must still surface. */
	test("propagates errors that are not a missing or corrupt file", async () => {
		const directory = await root();
		// A directory where the state file belongs: readable path, unreadable file.
		const { mkdir } = await import("node:fs/promises");
		await mkdir(join(directory, "collides.json"));

		expect(SessionState.open(directory, "collides")).rejects.toThrow();
	});
});
