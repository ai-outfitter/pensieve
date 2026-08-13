#!/usr/bin/env bun
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { importTranscripts, type ImportOptions, type ImportSummary } from "./importer.ts";
import { DEFAULT_MAX_BYTES } from "./transcript.ts";

const HELP = `pensieve-import imports existing Claude Code JSONL transcripts into a Pensieve sink.

Usage:
  pensieve-import --sink <url> --token <token> --identity <id>
                  [--source ~/.claude/projects] [--dry-run] [--since <date>]

Reconstructed evidence is not observed evidence. Every emitted record explicitly
sets provenance="imported" and observed=false, and records its absolute source
path and import timestamp. It omits install_scope because no collector observed
the original session. Absence remains unattested; importing a transcript does
not retroactively prove that capture was complete or authoritative.

Options:
  --sink URL             Pensieve sink base URL (required)
  --token TOKEN          bearer token for the importing machine (required)
  --identity ID          authenticated machine principal; must match token (required)
  --source PATH          transcript tree (default: ~/.claude/projects)
  --dry-run              read and classify files without contacting the sink or writing state
  --since DATE           only files modified on or after this ISO date
  -h, --help             show this help

Files larger than ${DEFAULT_MAX_BYTES / 1024 / 1024} MiB are skipped before upload. Source files are
opened read-only and are never modified or deleted. Successful payload digests
are checkpointed under the user's state directory so reruns report and skip them.
`;

function parseArgs(argv: string[]): ImportOptions | null {
	const values = new Map<string, string>();
	let dryRun = false;
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "-h" || argument === "--help") return null;
		if (argument === "--dry-run") {
			dryRun = true;
			continue;
		}
		if (!argument?.startsWith("--")) throw new Error(`unexpected argument: ${argument}`);
		const value = argv[++index];
		if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value`);
		if (!["--sink", "--token", "--identity", "--source", "--since"].includes(argument)) {
			throw new Error(`unknown option: ${argument}`);
		}
		values.set(argument, value);
	}
	for (const required of ["--sink", "--token", "--identity"]) {
		if (!values.get(required)) throw new Error(`${required} is required`);
	}
	let since: Date | undefined;
	if (values.has("--since")) {
		since = new Date(values.get("--since") as string);
		if (Number.isNaN(since.getTime())) throw new Error("--since must be a valid date");
	}
	const stateRoot = process.env.XDG_STATE_HOME ?? join(homedir(), ".local", "state");
	return {
		sink: values.get("--sink") as string,
		token: values.get("--token") as string,
		identity: values.get("--identity") as string,
		source: resolve(values.get("--source") ?? join(homedir(), ".claude", "projects")),
		dryRun,
		since,
		statePath: join(stateRoot, "pensieve", "claude-transcript-imports.json"),
	};
}

async function main(): Promise<void> {
	let options: ImportOptions | null;
	try {
		options = parseArgs(Bun.argv.slice(2));
	} catch (error) {
		console.error(`error: ${error instanceof Error ? error.message : String(error)}\n\n${HELP}`);
		process.exitCode = 2;
		return;
	}
	if (!options) {
		console.log(HELP);
		return;
	}
	console.log(`${options.dryRun ? "Dry run: scanning" : "Scanning"} ${options.source}`);
	let summary: ImportSummary;
	try {
		summary = await importTranscripts(options, undefined, (decision, completed, total) => {
			const label = decision.kind === "would-import" ? "WOULD IMPORT" : decision.kind.toUpperCase();
			console.log(`[${completed}/${total}] ${label} ${decision.path} — ${decision.reason}`);
		});
	} catch (error) {
		// A refused credential stops the run. Continuing would upload the rest of
		// the tree into storage that cannot release it, for records the sink will
		// refuse one by one.
		console.error(`\nAborted: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
		return;
	}
	console.log("\nSummary");
	console.log(`  discovered:   ${summary.discovered}`);
	console.log(`  imported:     ${summary.imported}`);
	if (options.dryRun) console.log(`  would import: ${summary.wouldImport}`);
	console.log(`  skipped:      ${summary.skipped}`);
	console.log(`  failed:       ${summary.failed}`);
	for (const [reason, count] of Object.entries(summary.reasons).sort(([a], [b]) => a.localeCompare(b))) {
		console.log(`  ${count} × ${reason}`);
	}
	if (summary.failed > 0) process.exitCode = 1;
}

if (import.meta.main) await main();
