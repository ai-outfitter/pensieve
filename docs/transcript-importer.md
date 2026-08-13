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

Remove `--dry-run` only after reviewing the decisions. `--since` compares the
date with each file's modification time, `--project` matches a substring of its
absolute path, and `--concurrency` controls simultaneous scans and uploads.

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

The importing workstation's authenticated principal is used as `identity`.
Claude Code and its discovered version are recorded as `harness` and
`harness_version`. `install_scope` is deliberately omitted: no Pensieve
installation observed these historical sessions. The unrecoverable original
policy is represented as `policy_digest: "unattested:imported"`, never guessed.

## Safety and reruns

The importer opens source files read-only and never modifies or deletes them.
It uploads the original bytes verbatim even when individual JSONL lines are
malformed. It scans all parseable lines for `sessionId`, `cwd`, `version`, and
`gitBranch`; a file without a `sessionId` is skipped.

Files over 60 MiB are skipped before any request, leaving headroom below the
64 MiB ingress cap. Successfully recorded payload digests are stored in
`$XDG_STATE_HOME/pensieve/claude-transcript-imports.json` (or
`~/.local/state/pensieve/claude-transcript-imports.json`). A rerun uses that
content digest checkpoint to report and skip records already imported. The
checkpoint records a pending attempt before upload and marks it complete only
after the transcript record is accepted. A retry reuses the same import
timestamp, so its content-addressed record remains identical even if the first
response was lost.
