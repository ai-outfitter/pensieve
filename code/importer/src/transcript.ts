import { CryptoHasher } from "bun";
import { readdir, stat } from "node:fs/promises";
import { join, resolve } from "node:path";

export const DEFAULT_MAX_BYTES = 60 * 1024 * 1024;

export interface TranscriptMetadata {
	sessionId?: string;
	cwd?: string;
	version?: string;
	gitBranch?: string;
}

export interface TranscriptInspection {
	path: string;
	size: number;
	modifiedAt: Date;
	digest?: string;
	metadata: TranscriptMetadata;
	malformedLines: number;
	skipReason?: "empty" | "too-large" | "missing-session-id";
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

function captureMetadata(line: string, metadata: TranscriptMetadata): boolean {
	if (!line.trim()) return true;
	let value: unknown;
	try {
		value = JSON.parse(line);
	} catch {
		return false;
	}
	if (typeof value !== "object" || value === null || Array.isArray(value)) return true;
	const event = value as Record<string, unknown>;
	for (const field of ["sessionId", "cwd", "version", "gitBranch"] as const) {
		if (metadata[field] === undefined && typeof event[field] === "string" && event[field].length > 0) {
			metadata[field] = event[field];
		}
	}
	return true;
}

/** Hash original bytes while independently parsing complete JSONL lines. */
export async function inspectTranscript(path: string, maxBytes = DEFAULT_MAX_BYTES): Promise<TranscriptInspection> {
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
	for await (const chunk of Bun.file(path).stream()) {
		hasher.update(chunk);
		pending += decoder.decode(chunk, { stream: true });
		let newline = pending.indexOf("\n");
		while (newline >= 0) {
			const line = pending.slice(0, newline).replace(/\r$/, "");
			pending = pending.slice(newline + 1);
			if (!captureMetadata(line, base.metadata)) base.malformedLines += 1;
			newline = pending.indexOf("\n");
		}
	}
	pending += decoder.decode();
	if (pending.length > 0 && !captureMetadata(pending.replace(/\r$/, ""), base.metadata)) base.malformedLines += 1;
	const digest = hasher.digest("hex");
	if (!base.metadata.sessionId) return { ...base, digest, skipReason: "missing-session-id" };
	return { ...base, digest };
}
