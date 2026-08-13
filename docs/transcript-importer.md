# Importing Claude Code transcripts

`pensieve-import` reconstructs transcript records from Claude Code's existing
append-only JSONL session files. Run it from the `code/` workspace:

```sh
bun run importer/src/cli.ts \
  --sink https://pensieve.example \
  --token "$PENSIEVE_TOKEN" \
  --identity agent:ncrmro-workstation \
  --source ~/.claude/projects \
  --dry-run
```

Remove `--dry-run` only after you review the decisions.

Pass the importing workstation's authenticated machine principal as
`--identity`. It must name the same principal that `--token` authenticates. The
sink accepts a payload from any writer but refuses a record whose identity
disagrees with the token (SRV-001.2.4), so a mismatch is fatal to the run.

`--source` sets the transcript tree to scan. To import one project, point it at
that project's directory. `--since` imports only the files modified on or after
the given ISO date.

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

The value you pass as `--identity` becomes the record's `identity`. The importer
records Claude Code and its discovered version as `harness` and
`harness_version`. `install_scope` is deliberately omitted: no Pensieve
installation observed these historical sessions. The unrecoverable original
policy is represented as `policy_digest: "unattested:imported"`, never guessed.

## Safety and reruns

The importer opens source files read-only and never modifies or deletes them.
It uploads the original bytes verbatim even when individual JSONL lines are
malformed. It scans all parseable lines for `sessionId`, `cwd`, `version`, and
`gitBranch`; a file without a `sessionId` is skipped.

Files over 60 MiB are skipped before any request. The threshold leaves headroom
below the request-body limit a deployment's ingress applies; it is a property of
the deployment, not of the sink, so confirm it for your own. Successfully
recorded payload digests are stored in
`$XDG_STATE_HOME/pensieve/claude-transcript-imports.json` (or
`~/.local/state/pensieve/claude-transcript-imports.json`). A rerun uses that
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
| `no sessionId` | no parseable line carries a `sessionId` |
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
