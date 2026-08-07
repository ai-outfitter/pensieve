# Pensieve

Pensieve collects what agents leave behind — session transcripts, tool calls, model exchanges, diffs, screenshots, logs, approvals, attestations — and writes it once into a store that cannot be rewritten. The default backend is S3 with Object Lock. The backend is an interface, not an assumption.

Collection is not a wrapper you have to remember to run. Each harness gets a **collector**, shipped as an extension and installed at the system-root extension hook — the same install point an organization already uses to push Outfitter profiles from its `.agents` repository. If the org can install its catalog on a machine, it can install evidence collection on that machine, and the engineer running the agent does not have to opt in.

> **Status:** design stage, as of 2026-08-07. This README states the intended shape and the contracts the implementation has to satisfy. No code has been written yet. Commands shown below are illustrative.

## Why

An agent run leaves its evidence in the place least able to keep it: a laptop, an ephemeral CI runner, a pod that exits. What survives is a pull request and a summary — the two artifacts an agent is best at producing and a reviewer is least able to check.

The demand from organizations adopting agentic development is for **auditability, not observability**. These are different artifacts built on different assumptions. An observability system aggregates and expires. An audit record binds a single event to a work item, an agent identity, an environment, and an artifact hash, and retains it. The second cannot be reconstructed from the first after the fact, which makes it a design decision rather than a later feature.

So: capture the bytes first, and design views over them second. A ledger, a control register, an audit viewer, an eval corpus, and a duplicate-work index can all be built later from a complete store. None of them can be built from a store that was never written.

## What Pensieve is

1. **An evidence sink.** It accepts records, stores payloads content-addressed under a write-once lock, and returns a signed **storage statement** binding the record digest, the content digest, the object version, the sink identity, the storage mechanism, and the actual lock deadline. A caller that holds a storage statement can prove the payload exists and cannot be deleted before a stated time.
2. **A set of collectors.** One per harness, each installed through that harness's native extension channel, each emitting the same record shapes.
3. **A verifier.** `pensieve verify` re-reads a run's records from the store and checks digests, storage statements, retention floors, and declared capture gaps, without trusting the process that wrote them.

## What Pensieve is not

Pensieve stores and proves storage. It does not decide what should be stored, whether a control fired, or whether a run is conformant.

- Control obligations, enforcement compilation, the evidence ledger's semantics, and the control register belong to the Outfitter governance layer — see [RFC: Outfitter Governance](https://github.com/ai-outfitter/outfitter/issues/253).
- Lineage rules — which node output fed which node input — belong to the graph runtime. Pensieve holds the artifacts those rules reference.
- Dashboards are a view over this record. They are not the record.

A useful test: if a question can be answered by reading bytes and checking a signature, it is Pensieve's. If it needs a policy, it is not.

## Records

A record is a small, signed, immutable JSON document plus zero or one payload. The record is hashed **before** any storage proof exists; the sink then signs a statement over that digest. This ordering avoids a digest cycle and is why the storage statement is a separate object rather than a field.

Every record MUST carry:

| Field | Meaning |
| --- | --- |
| `kind` | session, commit-evidence, transcript, tool-call, model-exchange, patch, image, log, network, approval, attestation, sbom, capture-failure, derivation, landing, release-bundle |
| `run` | the run this record belongs to, and the attempt within it |
| `identity` | the agent identity that acted — never a human account an agent happened to run under |
| `environment` | where the request was processed: workstation, CI runner, cluster pod |
| `policy` | digest of the configuration in force at the time, so a reviewer sees what governed the run |
| `digest` | complete content digest of the payload |
| `locator` | immutable object locator, including the storage version |
| `retention` | the materialized payload and record retention commitments |

Three kinds carry the forge story. **`commit-evidence`** is the gating unit: the collector seals one per commit, covering the session segment that produced it, and binds both the exact SHA and the commit's `patch_id` — the durable identity of the change, which survives rebase, cherry-pick, and merge-queue re-forming. **`landing`** binds one protected-ref update to the evidence covering the commits it introduced, which is what keeps a squash-merged `main` verifiable. **`release-bundle`** aggregates a tag's whole commit range into the one document an auditor reads.

Retention expiry means *eligible for disposition*, not *deleted*. Extensions, legal holds, releases, and disposition append as new events with their own storage statements. Effective retention can increase. It cannot decrease.

## Backends

The store is one interface — `put`, `head`, `get`, `statement`, `hold`, `dispose` — with these implementations planned:

| Backend | Write-once mechanism | Use |
| --- | --- | --- |
| **S3** | Object Lock, compliance mode, versioned bucket | Default. Every deployment target already speaks it. |
| **MinIO** | Object Lock, compliance mode | Local bring-up, on-premises, air-gapped deployments. Same code path as S3. |
| **Filesystem** | none | Development only. A dev sink signs nothing; it hashes its own claim and reports itself **non-conforming** so a run can never accidentally look audited. |
| **Others** | vendor immutability | GCS retention policies, Azure Blob immutable storage, and customer-operated WORM appliances fit the same interface. |

Pluggability is a requirement, not a courtesy. The store MUST be able to run inside the customer's boundary, including air-gapped, and a customer with a mandated storage vendor cannot be told to adopt a second one to get an audit trail.

## Collectors

A collector is a thin, deterministic component. It captures, redacts by profile, and forwards. It contains no model calls and makes no decisions the run can influence.

| Harness / surface | Install channel |
| --- | --- |
| Claude Code | hooks in the composed `settings.json`, wired at session start, tool call, and edit events |
| Pi | an extension package loaded at session start, registering the capture hooks |
| CI (`ai-outfitter/actions`) | a step pinned by digest, so the run cannot widen or disable it |
| Kubernetes (`ai-outfitter/agent-operator`) | operator-mounted sidecar with a short-lived workload identity |
| Anything else | `pensieve wrap -- <command>`, which captures stdio and process metadata |

New harnesses arrive as new collector plugins against a stable record contract. Adding one MUST NOT require a change to the sink.

### Where collectors get installed

Organizations already have an answer to "how does every machine get the same agent configuration": a system-root install of the org's `.agents` catalog, placed where an engineer does not edit it and does not remove it. Harnesses expose exactly this scope. Claude Code, for example, reads a managed policy file before any user or project file:

| Platform | Managed policy location |
| --- | --- |
| Linux, WSL | `/etc/claude-code/CLAUDE.md` |
| macOS | `/Library/Application Support/ClaudeCode/CLAUDE.md` |
| Windows | `C:\Program Files\ClaudeCode\CLAUDE.md` |

Source: [Claude Code memory — choose where to put your CLAUDE.md files](https://code.claude.com/docs/en/memory#choose-where-to-put-claude-md-files).

Pensieve rides that same channel. The property that matters is not the specific path but the ordering: the collector is installed by whoever owns the machine, ahead of anything the session can change. Evidence collection an agent can turn off is evidence collection that will be reported as complete on the runs where it was off.

That ordering does not hold on every harness. Claude Code and Codex both have a managed scope a session cannot override; Pi resolves configuration only from user and project scope, so its collector is authoritative only where the machine offers a wrapped launcher rather than a bare `pi`. Every collector therefore records its own install scope, and a verifier reads that scope to decide whether collection was authoritative or advisory — see [CLC-001.2](./docs/requirements/CLC-001-harness-collectors.md).

## Capture completeness

Silence and success must not look alike.

- A run MUST record which artifact classes its capture profile required, and every class it failed to capture.
- A required capture gap marks the run `failed-evidence`. Downstream consumers that gate on evidence MUST treat that as a stop, not a warning.
- Partial evidence from failed, cancelled, and retried attempts MUST be retained. Each retry is a new attempt with its own session record.
- A capture profile MUST name a primary sink and an independent emergency failure sink under a different identity and failure domain. If the primary sink fails, the collector writes a signed minimal capture-failure record to the emergency path.
- Prohibited material MUST NOT be captured and deleted later. Where a retention obligation conflicts with a privacy or residency rule, the profile fails to load.

## Specification

Formal obligations live in [`docs/requirements/`](./docs/requirements/README.md), split by the component that can fail them:

- [SRV-001: Evidence Sink](./docs/requirements/SRV-001-evidence-sink.md) — identity, ingest, the record model, write-once storage and statements, retention and holds, landing records, reconciliation, release bundles, verification.
- [CLC-001: Harness Collectors](./docs/requirements/CLC-001-harness-collectors.md) — install authority, commit segmentation, capture completeness, redaction, delivery, per-harness projections, bypass.
- [CICD-001: Evidence Gates](./docs/requirements/CICD-001-evidence-gates.md) — the four forge gates, their authority, failure semantics, the coverage epoch and ratchet, forge portability.

[`code/example-repo/`](./code/example-repo/README.md) is the working shape of CICD-001: five GitHub workflows, two rulesets, and a repository policy file.

## Local bring-up (planned)

The first deliverable is a `docker compose up` that starts MinIO with Object Lock, the Pensieve sink, and a read-only viewer, then runs a scripted agent session against it so the whole path is visible in one terminal and one browser tab:

```bash
git clone git@github.com:ai-outfitter/pensieve.git
cd pensieve
docker compose up          # planned
pensieve verify run/<id>   # planned
```

A store you cannot see working is a store nobody believes.

## The name

A pensieve is a basin you deposit memories into so that they can be examined later, exactly as they happened, by someone who was not there. That is the whole product.

## License

MIT.
