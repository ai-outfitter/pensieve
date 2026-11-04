# EVL-002: Agent Records

> **Status: proposed standard (`pensieve.agent-record/v0`), 2026-11-04.** The
> field names and layout are stable enough to build against; statements may
> still be amended under the usual rules before v1.

## Overview

An **agent record** is the evidence of one model call: the exact request a
client sent to a provider, what came back, and the tool calls that response
asked for, with their inputs and outputs. One record covers one step of an
agent's tool loop. A turn that calls the model four times leaves four records,
ordered by `sequence.step`.

Records are written once and never rewritten. They are stored in an object
store (R2 hosted, RustFS or another S3 store self-hosted) for audits and evals,
and cited by digest: an evaluation bundle ([EVL-001](./EVL-001-evaluation-bundles.md))
or an index row names a record by the SHA-256 of its canonical bytes.

`@pensieve/eval` (`code/eval/`) defines the format, builds records for writers,
and validates them offline. Any client may write records; Outfitter is the
first. The format is independent of any model SDK: a writer maps its own SDK's
step to `AgentRecordInput`.

What a record is not:

- **Not published.** Records are admin-only evidence. They carry no publication
  profile and are never redacted; a record holds exactly what was sent and
  received, credentials in tool output included. Who may read them is the
  store's and the reading application's access control, not the format's.
- **Not retained by code.** Retention is a lifecycle rule (TTL) on the bucket.
  No application code deletes or expires records or blobs.
- **Not an attestation.** A record digest proves the integrity of what was
  saved, as a manifest digest does (EVL-001.5.2), not that the call happened.

## Layout

```
records/<yyyy>/<mm>/<dd>/<record-id>.json    the record, canonical JSON
blobs/<sha256>                               content-addressed bodies
```

The date is the UTC date of `recorded_at`. A blob's key is the lowercase hex
SHA-256 of its exact bytes, so the same bytes always land at the same key and an
existing blob is never rewritten.

## Record

The schema is the TypeScript `AgentRecord` type in
[`code/eval/src/record.ts`](../../code/eval/src/record.ts). Every field is
required; nullable fields are written as `null`, never omitted.

| Field | Meaning |
| --- | --- |
| `standard` | `pensieve.agent-record/v0` |
| `id` | UUID v7, lowercase |
| `recorded_at` | when the writer built the record |
| `evidence` | `recorded`, `real-model`, or `live-provider` (EVL-001.3.1); production traffic is `live-provider` |
| `client` | `kind` (`outfitter`, `claude-code`, `codex`, `pi`, `otel`) and `version` or null |
| `context` | `kind` (`thread` or `workflow-step`), `thread_id`, `entry_id`, `workflow_run_id`, `workflow_step`, `organization_id`, `user_id` |
| `sequence` | `turn_key` (the submission or `run:step:turn` the call belongs to) and `step`, the call's index in the turn's tool loop from 0 |
| `model` | `provider`, `id`, and `settings` (free-form call settings such as temperature) |
| `request` | `body` (blob reference to the exact provider request body, or null), `system_digest` (SHA-256 of the system prompt text, or null), `tool_names` offered |
| `response` | `body` (blob reference to the provider response body, or null), `text` (assistant text, or null), `finish_reason` (null only when the call did not complete) |
| `usage` | `input_tokens`, `output_tokens`, `cached_input_tokens`, `reasoning_tokens`, each an integer or null when the provider does not report it |
| `tool_calls[]` | `call_id`, `name`, `input` / `input_blob`, `output` / `output_blob`, `error`, `status` (`ok`, `error`, `omitted`) |
| `timing` | `started_at`, `ended_at` |
| `status` | `complete`, `error`, or `aborted`, with `error` (message or null) |
| `blobs[]` | every blob the record cites, `{ digest, size, media_type }`, once each, sorted by digest |

A blob reference is `{ "digest", "size", "media_type" }`. A tool's input and
output each have an inline field and a `_blob` field: a small value is inline
JSON and its `_blob` is null; a large one is in a blob, and its inline field is
null. The split keeps a reference from ever being mistaken for a tool value
that happens to have the same three keys.

## Requirements

### EVL-002.1: Record and Identity

1. A record MUST describe exactly one model call and the tool calls in that call's response, and MUST be written once and never rewritten.
2. A record file MUST be byte-identical to the UTF-8 encoding of Pensieve's `canonicalize` of the record (SRV-001.3.3): no byte-order mark, no whitespace.
3. `standard` MUST name a standard the validator knows. A validator MUST reject an unknown standard rather than guess.
4. `id` MUST be a lowercase UUID v7.
5. A record's digest is the SHA-256 of its canonical bytes. Anything that cites a record (an index row, an evaluation bundle) MUST cite it by this digest.

### EVL-002.2: Layout and Writing

1. A record MUST be stored at `records/<yyyy>/<mm>/<dd>/<id>.json`, dated by the UTC date of `recorded_at`.
2. A blob MUST be stored at `blobs/<sha256>`, where the name is the SHA-256 of its exact bytes. A writer MUST NOT rewrite an existing blob.
3. `request.body` MUST be the exact body the client sent to the provider, as bytes or text, not a reconstruction. A writer that cannot see it MUST write null.
4. A writer SHOULD put the request and response bodies in blobs, and MUST put a tool input or output in a blob when its canonical JSON exceeds 4 KiB or would push the record past the depth limit (EVL-002.5.3).
5. A writer MUST validate a record before writing it and MUST refuse to write an invalid one. It MUST store every blob a record cites before the record itself, so a stored record never cites a blob that is not there.
6. Retention MUST be a lifecycle rule on the bucket. Application code MUST NOT delete, expire, or rewrite records or blobs.
7. Records MUST NOT carry a publication profile, a sensitivity marking, or redaction. Access to records is decided by the store and the reading application.

### EVL-002.3: Schema

1. A record MUST NOT contain fields the standard does not define, except inside `model.settings`. A validator MUST reject unknown fields rather than ignore them.
2. Digests (blob digests, `request.system_digest`) MUST be 64 lowercase hex characters, sizes non-negative integers, and media types `type/subtype`.
3. Timestamps MUST be ISO-8601 date-times with an explicit offset, and `timing.ended_at` MUST NOT be earlier than `timing.started_at`.
4. `status` MUST agree with the rest of the record: `complete` needs `error = null` and a `finish_reason`; `error` needs a non-empty `error`; `aborted` MAY have either.
5. A `thread` context MUST name `thread_id`; a `workflow-step` context MUST name `workflow_run_id` and `workflow_step`.
6. A tool call MUST have a unique `call_id` within the record. Its input and output MUST each be inline or in a blob, never both. `ok` needs `error = null`; `error` needs a non-empty `error`; `omitted` (output not captured) MUST have no output.
7. `blobs` MUST list every cited blob exactly once, sorted by digest, with the same size and media type as every reference to it, and MUST NOT list a blob the record does not cite.

### EVL-002.4: Integrity and Gaps

1. Given a blob store, a validator MUST fail a record whose listed blob is missing, or whose size or SHA-256 does not match.
2. A null `request.body`, a null `response.body` on a complete call, and an `omitted` tool output are capture gaps. A validator MUST report each gap and MUST NOT count it as a failure, so missing capture is visible without making the record invalid.

### EVL-002.5: Portability

1. Validation MUST run offline, with no model, provider, or network access, except a blob store the caller supplies.
2. Record building and validation MUST run unchanged under Node, Bun, and Cloudflare Workers. Filesystem access MUST live in a separate module.
3. A validator MUST NOT throw on malformed input. It MUST report a record that is not an object, holds non-JSON values, exceeds 8 MiB, or nests deeper than 32 levels as an issue.

## API

From `@pensieve/eval` (pure, Workers-safe):

- `buildRecord(input: AgentRecordInput): Promise<BuiltRecord>`: fills `standard` and `blobs`, validates, and returns `{ record, bytes, digest, key }`; throws on an invalid record.
- `validateRecord(input: Uint8Array | string | unknown, options?: { file?: string }): RecordReport`: bytes or text are also checked for canonical form; never throws.
- `verifyRecordBlobs(record: unknown, getBlob: (digest) => Promise<Uint8Array | null>): Promise<Issue[]>`
- `splitBody(body: unknown, mediaType = "application/json"): Promise<{ ref: BlobRef; bytes: Uint8Array }>`, `blobRef(bytes, mediaType?)`, `recordDigest(record | bytes)`, `recordKey({ id, recorded_at })`, `blobKey(digest)`, and `BLOB_THRESHOLD_BYTES`.

From `@pensieve/eval/node`: `validateRecordFile(path, { blobs?: dir }): Promise<RecordReport>`.

CLI: `pensieve-eval record validate <record-file...> [--blobs <dir>] [--json]`.
Exit 0 when every record is valid, 1 when one is not, 2 on bad usage. Gaps are
printed but do not change the exit code.
