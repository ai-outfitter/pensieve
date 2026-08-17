import { CryptoHasher } from "bun";
import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { HarnessAdapter, TranscriptMetadata } from "./harness.ts";

// A hard sanity cap, not an upload limit. Files above the direct-POST
// threshold upload through a presigned PUT straight to the object store, so
// this bounds only how much one pathological file can occupy an import run.
export const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024;

/** Lines buffered for detection before a file is declared unrecognized. */
const DETECT_WINDOW = 25;

export type { TranscriptMetadata } from "./harness.ts";

export interface TranscriptInspection {
	path: string;
	size: number;
	modifiedAt: Date;
	digest?: string;
	/** The adapter whose detect() claimed this file; unset when none did. */
	harness?: string;
	metadata: TranscriptMetadata;
	malformedLines: number;
	skipReason?: "empty" | "too-large" | "missing-run" | "unknown-harness";
}

/** Find regular .jsonl files without following directory symlinks. */
export async function findTranscripts(source: string): Promise<string[]> {
	const found: string[] = [];
	const pending = [resolve(source)];
	while (pending.length > 0) {
		const directory = pending.pop();
		if (!directory) break;
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) pending.push(path);
			else if (entry.isFile() && entry.name.endsWith(".jsonl")) found.push(path);
		}
	}
	return found.sort();
}

/**
 * Hash original bytes while independently parsing complete JSONL lines.
 *
 * One pass does three jobs: the raw chunks feed the SHA-256 hasher, so the
 * digest is of the file exactly as it exists on disk and no parse can reach
 * it; the decoded lines feed harness detection, which is by CONTENT — the
 * first adapter whose detect() recognizes the buffered lines claims the file,
 * and a path under ~/.codex can never make a file "codex"; and once claimed,
 * every line (including the buffered prefix) flows through the adapter's
 * scanLine to fold out metadata.
 */
export async function inspectTranscript(
	path: string,
	adapters: HarnessAdapter[],
	maxBytes = DEFAULT_MAX_BYTES,
): Promise<TranscriptInspection> {
	const info = await stat(path);
	const base = {
		path: resolve(path),
		size: info.size,
		modifiedAt: info.mtime,
		metadata: {} as TranscriptMetadata,
		malformedLines: 0,
	};
	if (info.size === 0) return { ...base, skipReason: "empty" };
	if (info.size > maxBytes) return { ...base, skipReason: "too-large" };

	const hasher = new CryptoHasher("sha256");
	const decoder = new TextDecoder();
	let pending = "";
	let adapter: HarnessAdapter | undefined;
	const window: unknown[] = [];

	const visit = (line: string): void => {
		if (!line.trim()) return;
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			base.malformedLines += 1;
			return;
		}
		if (adapter === undefined && window.length < DETECT_WINDOW) {
			window.push(value);
			adapter = adapters.find((candidate) => candidate.detect(window));
			if (adapter) {
				for (const buffered of window) adapter.scanLine(buffered, base.metadata);
				window.length = 0;
			}
			return;
		}
		adapter?.scanLine(value, base.metadata);
	};

	for await (const chunk of Bun.file(path).stream()) {
		hasher.update(chunk);
		pending += decoder.decode(chunk, { stream: true });
		let newline = pending.indexOf("\n");
		while (newline >= 0) {
			visit(pending.slice(0, newline).replace(/\r$/, ""));
			pending = pending.slice(newline + 1);
			newline = pending.indexOf("\n");
		}
	}
	pending += decoder.decode();
	if (pending.length > 0) visit(pending.replace(/\r$/, ""));

	const digest = hasher.digest("hex");
	// A file no adapter recognizes is declared, never guessed: writing it under
	// an assumed harness would put a wrong attribution into a store that cannot
	// correct it. CLC-001.4.4.
	if (adapter === undefined) return { ...base, digest, skipReason: "unknown-harness" };
	if (!base.metadata.run) return { ...base, digest, harness: adapter.harness, skipReason: "missing-run" };
	return { ...base, digest, harness: adapter.harness };
}
