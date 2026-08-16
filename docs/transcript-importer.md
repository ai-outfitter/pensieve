# Importing coding-agent transcripts

`pensieve-import` reconstructs transcript records from the JSONL session files
that Claude Code, Codex, and pi already keep on disk. It identifies each file
by its content — a path under `~/.codex` can never make a file "codex" — and
each harness's specifics live in one adapter file under
`code/importer/src/adapters/`. Run it from the `code/` workspace:

```sh
bun run importer/src/cli.ts \
  --sink https://pensieve.example \
  --token "$PENSIEVE_TOKEN" \
  --identity agent:ncrmro-workstation \
  --dry-run
```

Remove `--dry-run` only after you review the decisions.

Pass the importing workstation's authenticated machine principal as
`--identity`. It must name the same principal that `--token` authenticates. The
sink accepts a payload from any writer but refuses a record whose identity
disagrees with the token (SRV-001.2.4), so a mismatch is fatal to the run.

With no `--harness` and no `--source`, the importer scans all three harnesses'
default roots: `~/.claude/projects`, `~/.codex/sessions`, and
`~/.pi/agent/sessions`. `--harness` restricts the run to one harness.
`--source` sets one tree to scan; files in it are still identified by content.
`--since` imports only the files modified on or after the given ISO date.

## Identity is composite

`run` groups transcripts: the session or thread the work belongs to. A Claude
subagent sidechain carries its parent's session id, so it shares the parent's
`run` — and 1458 sidechain files are why `run` alone is not an identity.
`transcript_id` is unique per file: the agent id for a Claude sidechain, the
rollout id for Codex, the session id elsewhere. `parent_run` names a different
run this one descends from (a Codex `parent_thread_id`, a forked session), and
is null where the harness has none.

Fields no harness records are null, never inferred: pi keeps no harness version
and no git information; only Codex records a commit SHA.

## Reconstruction is not observation

An imported transcript proves that particular bytes were placed in the sink at
import time. It does not prove that a collector observed the original session,
that the transcript is complete, or that a capture policy was enforced. Absence
of an observed record remains unattested, never clean (CLC-001.8.2).

For that reason every imported record carries all four explicit markers:

```json
{
  "provenance": "imported",
  "observed": false,
  "imported_from": "/absolute/path/to/session.jsonl",
  "imported_at": "2026-08-11T12:00:00.000Z"
}
```

The value you pass as `--identity` becomes the record's `identity`. The adapter that claimed the file records `harness` and `harness_version`;
pi keeps no version anywhere, so its records carry `harness_version: null`. `install_scope` is deliberately omitted: no Pensieve
installation observed these historical sessions. The unrecoverable original
policy is represented as `policy_digest: "unattested:imported"`, never guessed.

## Safety and reruns

The importer opens source files read-only and never modifies or deletes them.
It uploads the original bytes verbatim even when individual JSONL lines are
malformed. Each adapter scans the parseable lines for its own metadata fields; a file
with no run identity, and a file no adapter recognizes, are skipped and named
in the summary.

Files over 60 MiB are skipped before any request. The threshold leaves headroom
below the request-body limit a deployment's ingress applies; it is a property of
the deployment, not of the sink, so confirm it for your own. Successfully
recorded payload digests are stored in
`$XDG_STATE_HOME/pensieve/transcript-imports.json` (or
`~/.local/state/pensieve/transcript-imports.json`); each entry records which
harness claimed the file. A rerun uses that
content digest checkpoint to report and skip records already imported. The
checkpoint records a pending attempt before upload and marks it complete only
after the transcript record is accepted. A retry reuses the same import
timestamp, so its content-addressed record remains identical even if the first
response was lost.

## What the command reports

Each file gets one line labelled `WOULD IMPORT`, `IMPORTED`, `SKIPPED`, or
`FAILED`, then a summary of the counts. The command exits 1 if any file failed,
2 if the arguments were wrong, and 0 otherwise.

A file is skipped for one of these reasons:

| Reason | Meaning |
| --- | --- |
| `empty file` | the file has no bytes |
| `exceeds safe upload threshold` | the file is over the size limit above |
| `no run identity` | no parseable line carries this harness's session identity |
| `no harness adapter recognizes this file` | detection is by content, and no adapter claimed it |
| `payload digest already imported` | these exact bytes are already in the sink |
| `duplicate payload digest in source tree` | another path in this run has the same bytes |
| `older than --since` | the file predates the given date |
| `source grew since import and the prior record digest is unknown` | see below |
| `run aborted` | a credential was refused, so the run stopped |

A rerun retries only the files that did not complete. It is safe to run the
command again after a failure.

## A session that is still running

A Claude Code transcript is append-only, so a session that was live during an
earlier import comes back with different bytes and a different digest. The
importer does not simply import it again: two unlinked transcript records for
one session, in a store that can withdraw neither, leave a reader unable to tell
which is later.

Instead the new record names the record it replaces, in `supersedes`
(SRV-001.3.5). This needs the earlier record's digest, which the importer only
retains from the run that wrote it. Where that digest is unknown — as for any
record imported before the importer kept it — the file is skipped and reported,
because a correction that cannot name what it corrects is worse than no
correction.

Import a session after it ends, and none of this applies.
