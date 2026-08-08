# `code/`

A Bun workspace. Three published pieces and one shared library.

| Package | Path | What it is |
| --- | --- | --- |
| `@pensieve/server` | `server/` | The evidence sink — ingest, write-once storage, storage statements, coverage queries. Implements [SRV-001](../docs/requirements/SRV-001-evidence-sink.md). |
| `@pensieve/collector-core` | `collectors/core/` | Shared collector library: client with durable spool, commit segmentation, git and patch-id helpers, session state. |
| `@pensieve/collector-claude` | `collectors/claude/` | Claude Code collector — managed-settings hooks. |
| `@pensieve/collector-codex` | `collectors/codex/` | Codex collector — managed lifecycle hooks. |
| `@pensieve/collector-pi` | `collectors/pi/` | Pi collector — in-process extension. |
| — | `example-repo/` | The forge gates as GitHub workflows and rulesets. Implements [CICD-001](../docs/requirements/CICD-001-evidence-gates.md). |

```sh
bun install
bun test          # 17 tests, each pinned to a requirement ID
bunx tsc --noEmit
sh scripts/build-collectors.sh dist
```

## Server

`Bun.serve` over a store interface. The parts worth reading first:

- **`store/sigv4.ts` and `store/s3.ts`** — S3 is spoken directly rather than through a convenience client, because Pensieve needs a `PUT` carrying `x-amz-object-lock-retain-until-date` and a `GET` of the `?retention` subresource. Applying the lock and then **reading it back** is the substance of the whole product: the sink signs the retention the store reports, never the value it requested.
- **`canonical.ts`** — one canonical serialization, and the record digest computed *before* any storage statement exists. That ordering avoids a digest cycle.
- **`store/fs.ts`** — the development backend signs nothing, returns no retention, and reports itself non-conforming, so the demo stack can never look audited.
- **`sink.ts`** — ingest rejects a record whose declared identity is not the authenticated principal, and rejects agent work attributed to a human account.

Verification reads records back from the store and re-derives their digests. It never returns a conclusion from the index.

## Collectors

All three emit identical record shapes; only the install channel and the capture depth differ.

| | Install location | Reported scope | `model-exchange` |
| --- | --- | --- | --- |
| Claude Code | `/etc/claude-code/managed-settings.d/pensieve.json` | `managed` | declared gap |
| Codex | `/etc/codex/hooks.json` + `requirements.toml` | `managed` | declared gap |
| Pi | root-owned `/usr/local/bin/pi` wrapper | **`launcher`** | captured |

That table is the design in one place. Claude Code and Codex have a managed scope a session cannot override, but their hooks never carry the model request or response body — so a profile requiring `model-exchange` gets a declared gap and those runs seal `failed-evidence`. Pi is the inverse: `before_provider_request` hands over the request payload, but Pi has no managed scope at all, so the strongest available authority is a launcher wrapper and the collector says so by reporting `launcher`. A verifier reads the scope and knows whether collection was authoritative or advisory. Claiming otherwise is forbidden by CLC-001.2.4.

Command hooks are a new process per event, so segment state lives in a root-owned file under `/var/lib/pensieve/state`. The in-process Pi extension keeps it in memory.

Every collector observes git to find commits rather than trusting the agent to announce them, and records the invocation arguments it can see — including the ones that would disable it. A session in which the collector never ran produces no record at all, and the sink treats absence as unattested, never as clean.

## Local stack

From the repository root:

```sh
docker compose up -d
docker compose exec workbench outfitter
```

`compose.yaml` starts MinIO with a bucket created **with object lock** and a default COMPLIANCE retention, the sink, and a workbench built `FROM ghcr.io/ai-outfitter/outfitter` with all three collectors installed as root before the image drops to uid 1000.

The sink runs unattested until you give it a key, and says so on startup:

```sh
docker compose run --rm --entrypoint bun pensieve run src/keygen.ts
# then set PENSIEVE_SIGNING_KEY in .env and restart
```
