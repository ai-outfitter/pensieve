# `code/`

A Bun workspace. Three published pieces and one shared library.

| Package | Path | What it is |
| --- | --- | --- |
| `@pensieve/server` | `server/` | The evidence sink — ingest, write-once storage, storage statements, coverage queries. Implements [SRV-001](../docs/requirements/SRV-001-evidence-sink.md). |
| `@pensieve/collector-core` | `collectors/core/` | Shared collector library: client with durable spool, commit segmentation, git and patch-id helpers, session state. |
| `@pensieve/collector-claude` | `collectors/claude/` | Claude Code collector — managed-settings hooks. |
| `@pensieve/collector-codex` | `collectors/codex/` | Codex collector — managed lifecycle hooks. |
| `@pensieve/collector-pi` | `collectors/pi/` | Pi collector — in-process extension. |
| `@pensieve/importer` | `importer/` | Client-only import of historical Claude Code transcripts. |
| — | `example-repo/` | The forge gates as GitHub workflows and rulesets. Implements [CICD-001](../docs/requirements/CICD-001-evidence-gates.md). |

```sh
bun install
bun test          # 17 tests, each pinned to a requirement ID
bunx tsc --noEmit
sh scripts/build-collectors.sh dist
```

Historical Claude Code transcripts can be classified without writing anything:

```sh
bun run importer/src/cli.ts --sink <url> --token <token> --identity <machine-principal> --dry-run
```

Imported records are explicitly reconstructed (`provenance: "imported"`,
`observed: false`) and omit `install_scope`; see
[the importer documentation](../docs/transcript-importer.md).

## Server

`Bun.serve` over a store interface. The parts worth reading first:

- **`store/sigv4.ts` and `store/s3.ts`** — S3 is spoken directly rather than through a convenience client, because Pensieve needs a `PUT` carrying `x-amz-object-lock-retain-until-date` and a `GET` of the `?retention` subresource. Applying the lock and then **reading it back** is the substance of the whole product: the sink signs the retention the store reports, never the value it requested.
- **`canonical.ts`** — one canonical serialization, and the record digest computed *before* any storage statement exists. That ordering avoids a digest cycle.
- **`store/fs.ts`** — the development backend signs nothing, returns no retention, and reports itself non-conforming, so the demo stack can never look audited.
- **`sink.ts`** — ingest rejects a record whose declared identity is not the authenticated principal, and rejects agent work attributed to a human account.

Verification reads records back from the store and re-derives their digests. It never returns a conclusion from the index.

Opaque payloads can bypass the sink's data path when the S3 backend is active:

1. `POST /v0/payloads/presign` with `{ digest, size, content_type }`.
2. Send the bytes with the returned `PUT` method, URL, and exact headers.
3. `POST /v0/payloads/<digest>/seal` to receive the signed payload statement.

The five-minute capability binds the object key, SHA-256 checksum, content length and type, COMPLIANCE mode, and retain-until date. The seal reads the checksum, version, and retention back from the object store; it never substitutes the values used to create the URL. A durable client must request the URL while draining its spool, not when it first spools the payload. If a direct upload reports an expired signature, it requests a fresh URL and retries the same content-addressed payload. Records always continue through `/v0/records` so the sink can validate and index them.

## Collectors

All three emit identical record shapes; only the install channel and the capture depth differ.

| | Install location | Reported scope | `model-exchange` |
| --- | --- | --- | --- |
| Claude Code | `/etc/claude-code/managed-settings.d/pensieve.json` | `managed` | declared gap |
| Codex | `/etc/codex/hooks.json` + `requirements.toml` | `managed` | declared gap |
| Pi (direct `pi` through `PATH`) | root-owned `/usr/local/bin/pi` wrapper | **`launcher`** | captured |

That table is the design in one place. Claude Code and Codex have a managed scope a session cannot override, but their hooks never carry the model request or response body — so a profile requiring `model-exchange` gets a declared gap and those runs seal `failed-evidence`. Pi is the inverse: `before_provider_request` hands over the request payload, but Pi has no managed scope at all. The current installer creates a launcher wrapper and the collector reports `launcher`; it is advisory, never managed. A verifier reads the scope and knows whether collection was authoritative or advisory. Claiming otherwise is forbidden by CLC-001.2.4.

Command hooks are a new process per event, so segment state lives in a root-owned file under `/var/lib/pensieve/state`. The in-process Pi extension keeps it in memory.

Two practical notes. The Claude Code and Codex hooks compile to standalone binaries of roughly 90 MB each — that is Bun's runtime, and it is the price of a managed hook that does not depend on the session's own toolchain. The Pi build is a Node ESM extension directory. The launcher installer can find a bundled Pi binary, but its `/usr/local/bin/pi` wrapper only runs for callers that resolve `pi` through `PATH`. Outfitter instead starts its bundled Pi module with Node's `process.execPath`, so `outfitter run` bypasses that wrapper and must be wired to pass the extension directory explicitly.

Records spool to disk before they are sent, and the spool drains oldest-first, so a record submitted after an outage never overtakes one that has been waiting.

Every collector observes git to find commits rather than trusting the agent to announce them, and records the invocation arguments it can see — including the ones that would disable it. A session in which the collector never ran produces no record at all, and the sink treats absence as unattested, never as clean.

## Local stack

From the repository root:

```sh
docker compose up -d
docker compose exec workbench outfitter
```

`compose.yaml` starts MinIO with a bucket created **with object lock** and a default COMPLIANCE retention, the sink, and a workbench built `FROM ghcr.io/ai-outfitter/outfitter`. It installs the Claude and Codex hooks and the advisory Pi launcher before the image drops to uid 1000. The launcher does not intercept `outfitter run`; the workbench still needs explicit Outfitter-to-Pi extension wiring before that path collects Pi evidence.

The sink runs unattested until you give it a key, and says so on startup:

```sh
docker compose run --rm --entrypoint bun pensieve run src/keygen.ts
# then set PENSIEVE_SIGNING_KEY in .env and restart
```
