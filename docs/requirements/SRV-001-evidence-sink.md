# SRV-001: Evidence Sink

## Overview

The Pensieve server receives evidence records, stores their payloads under a
write-once lock, and signs statements that prove the storage. It answers
coverage questions about commits, refs, and releases. It does not decide
policy: it stores bytes, proves it stored them, and reports what it holds.

Terms used throughout:

- **Record** — a signed, immutable JSON document, with zero or one payload.
- **Payload** — the bytes a record describes, stored content-addressed.
- **Storage statement** — the sink's signed proof that a payload exists and is
  locked until a stated time.
- **Commit evidence** — the record that binds one commit to the session
  segment that produced it.
- **Landing record** — the record that binds one protected-ref update to the
  evidence that covers the commits it introduced.
- **Release bundle** — the aggregate record for one tag and its commit range.

## Requirements

### SRV-001.1: Sink Identity

1. The sink MUST hold a signing identity that is distinct from every agent identity and from every human identity.
2. Every statement the sink signs MUST name the sink identity, the signing key, and the storage mechanism in force.
3. The sink MUST publish its verification key at a stable location that a verifier can pin.
4. The sink MUST support key rotation without invalidating statements signed by a superseded key.
5. A superseded key MUST remain published for at least the longest retention commitment of any statement it signed.
6. A deployment that cannot sign MUST identify itself as an unattested development sink and MUST mark every record it accepts as non-conforming.

### SRV-001.2: Ingest and Authentication

1. The sink MUST authenticate every ingest request.
2. The sink MUST accept a workload identity token — OIDC from a forge runner, a Kubernetes service account, or an equivalent short-lived credential.
3. The sink MUST NOT require a long-lived shared secret for ingest.
4. The sink MUST reject a record whose declared acting identity differs from the authenticated principal.
5. The sink MUST NOT accept a record that attributes agent work to a human account.
6. The sink MUST reject evidence submitted by a CI job on behalf of a session that ran elsewhere.
7. The sink MUST record the authenticated principal, the source address, and the receipt time for every accepted record.
8. The sink MUST accept out-of-order and late delivery, and MUST NOT reject a record because a related record has not arrived.

### SRV-001.3: Record Model

1. Every record MUST declare `kind`, `run`, `attempt`, `identity`, `environment`, `policy_digest`, and `created_at`.
2. Every record that describes a payload MUST declare the payload `digest`, `media_type`, `size`, and `locator`.
3. The sink MUST define one canonical serialization and MUST compute a record digest over that serialization.
4. The sink MUST compute the record digest **before** any storage statement exists, and MUST sign the storage statement over the record digest. This ordering avoids a digest cycle and is not an implementation detail.
5. A stored record MUST be immutable. A correction MUST be a new record that references the superseded one.
6. The sink MUST reject a record that omits a required field, rather than storing it with a default.
7. `policy_digest` MUST identify the resolved agent configuration in force during the segment the record covers.
8. The sink MUST support the record kinds `session`, `commit-evidence`, `transcript`, `tool-call`, `model-exchange`, `patch`, `image`, `log`, `network`, `approval`, `attestation`, `sbom`, `capture-failure`, `derivation`, `landing`, and `release-bundle`.

### SRV-001.4: Commit Evidence

1. A `commit-evidence` record MUST bind one commit and MUST declare its `sha`, `tree`, `parents`, and `patch_id`.
2. `patch_id` MUST be computed so that a rebased or cherry-picked commit carrying the same change resolves to the same value.
3. A `commit-evidence` record MUST reference every record produced in the session segment between the previous commit boundary and this commit.
4. A `commit-evidence` record MUST declare its capture profile, the artifact classes that profile required, and every class that was not captured.
5. A `commit-evidence` record with an unmet required class MUST be sealed with status `failed-evidence`.
6. The sink MUST seal a `commit-evidence` record on receipt of its boundary marker and MUST reject later additions to a sealed record.
7. The sink MUST accept more than one `commit-evidence` record for the same `sha` only when they originate from the same run and attempt; otherwise it MUST record a conflict finding.
8. The sink MUST retain a terminal segment that produced no commit, and MUST NOT treat its absence of a commit as an error.
9. The sink MUST resolve a commit-evidence lookup by `sha` exactly, and MUST support a secondary lookup by `patch_id`.
10. A `patch_id` lookup MUST be reported as a derivation match, never as an exact match.

### SRV-001.5: Storage and Write-Once Guarantees

1. The sink MUST store payloads content-addressed by digest.
2. The sink MUST write each payload once and MUST NOT permit overwrite of a stored digest.
3. The sink MUST apply an object lock whose retain-until date meets or exceeds the record's payload-retention commitment before it signs a storage statement.
4. A storage statement MUST bind the record digest, the content digest, the object version, the sink identity, the storage mechanism, and the actual retain-until date read back from the store.
5. The sink MUST read the retain-until date back from the store. It MUST NOT sign the value it requested.
6. The sink MUST expose a backend interface of `put`, `head`, `get`, `statement`, `hold`, and `dispose`, and MUST implement every backend against that interface.
7. The default backend MUST be S3 with Object Lock in compliance mode on a versioned bucket.
8. The sink MUST support deployment inside a customer boundary, including an air-gapped network, with no call to a service outside that boundary.
9. A filesystem backend MUST be available for development, MUST NOT sign storage statements, and MUST report every record it holds as non-conforming.
10. The sink MUST verify payload availability on request by reading object metadata from the store, and MUST NOT answer an availability question from its own index alone.

### SRV-001.6: Retention, Holds, and Disposition

1. Every record MUST carry a materialized payload-retention commitment and a materialized record-retention commitment.
2. Retention expiry MUST mean eligible for disposition. It MUST NOT mean deleted.
3. Effective retention MAY increase. It MUST NOT decrease.
4. An extension, a legal hold, a hold release, an availability check, and a disposition MUST each append a new event with its own storage statement.
5. A retention event MUST NOT mutate the original commitment.
6. Every retention event MUST carry a signed per-operation authorization that binds the actor, the event type, the effective time, a nonce, and the canonical unsigned request.
7. The sink MUST reject a replayed authorization across actors, operations, or requests.
8. The sink MUST refuse to load a capture profile whose retention obligation conflicts with a declared privacy or data-residency rule. It MUST NOT capture prohibited material and rely on later deletion.

### SRV-001.7: Landing Records

1. The sink MUST accept a landing record for every observed update to a protected ref, and MUST record `ref`, `before`, `after`, and whether the update was forced.
2. A landing record MUST enumerate the commits the update introduced.
3. A landing record MUST assign every introduced commit exactly one attribution: `run`, `forge-generated`, `human`, `exempt`, or `unattested`.
4. An `exempt` attribution MUST name the policy rule that grants the exemption.
5. A landing record MUST declare the derivation of each landed commit from authored commits as one of `identical`, `squashed-from`, `rebased-from`, `cherry-picked-from`, or `merge-of`.
6. The sink MUST verify `identical` by SHA equality.
7. The sink MUST verify `squashed-from` and `merge-of` by recomputing the merge from the recorded inputs and comparing trees. It MAY first attempt a composed-patch comparison as a fast path, and a fast-path miss MUST fall through to recomputation rather than fail.
8. The sink MUST verify `rebased-from` and `cherry-picked-from` by `patch_id` equality.
9. Content that no derivation explains MUST be recorded as `tree_delta` and MUST be attributed to the identity that performed the update.
10. A landing record whose `before` does not equal the previous record's `after` for that ref MUST be recorded as a chain break.
11. An update whose `after` does not have `before` as an ancestor MUST be recorded as a history rewrite, and the records of the orphaned commits MUST be retained.
12. Ref creation MUST be accepted with `before` set to the zero object.
13. Deletion of a protected ref MUST produce a landing record with an empty introduced-commit set and MUST be recorded as a finding.
14. A landing record MAY open in state `unattested-pending` when the covering evidence has not yet sealed, MUST carry a resolution deadline, and MUST resolve by appending a resolution event rather than by mutation.

### SRV-001.8: Reconciliation

1. The sink MUST reconcile each protected ref by walking its history and comparing it against the landing chain.
2. Reconciliation MUST be the authority on completeness. An event stream MUST NOT be the authority, because events are missed and forge push payloads truncate their commit lists.
3. Reconciliation MUST report, in both directions, every commit with no landing record and every landing record with no commit on the ref.
4. Reconciliation MUST run on a schedule and MUST be invocable on demand.
5. Reconciliation MUST NOT mutate existing records. It MUST append findings.

### SRV-001.9: Release Bundles

1. A release bundle MUST declare the tag, the commit range it covers, and the previous tag that bounds the range.
2. A release bundle MUST enumerate every commit in the range with its coverage state and its storage statements.
3. A release bundle MUST enumerate every distinct `policy_digest` in force across the range and every contributing identity.
4. A release bundle MUST enumerate every uncovered commit and every declared gap.
5. The sink MUST sign the release bundle and MUST store it with its own storage statement.
6. A release bundle MUST carry a freshness lifetime.
7. A verifier MUST treat a release bundle past its freshness lifetime as unknown. Unknown MUST NOT be reported as conforming.

### SRV-001.10: Query and Verification

1. The sink MUST answer whether a given commit SHA has sealed, conforming evidence.
2. The sink MUST answer whether every commit in a given range has coverage, and MUST return the uncovered set rather than a boolean alone.
3. The sink MUST answer which run and identity produced a given commit.
4. A verification answer MUST be reproducible by a caller that holds the records, the storage statements, and the sink verification key. The caller MUST NOT have to trust the sink's conclusion.
5. The sink MUST expose a verification path that reads records back from the store rather than from any cache or index built at write time.
6. The sink MUST issue short-lived read credentials in exchange for a validated workload identity token, and MUST scope them to the repository and ref claimed by that token.

### SRV-001.11: Availability and Failure

1. The sink MUST answer an unanswerable question with an explicit unknown. It MUST NOT answer with a conforming verdict.
2. The sink MUST accept a capture-failure record from an emergency sink identity.
3. The emergency sink MUST use a different identity and a different failure domain from the primary sink.
4. The emergency sink MUST retain a capture-failure record before that record enters any ledger.
5. The sink MUST NOT silently drop a record. A rejection MUST return a typed error the collector can act on.
6. The sink SHOULD be operated as a merge-path and deploy-path dependency, because CICD-001.7 requires gates to fail closed when it is unreachable.

### SRV-001.12: Boundaries

1. The sink MUST NOT define control obligations. Obligations are owned by the governance layer.
2. The sink MUST NOT compute whether a control fired. It stores the evidence that a verifier uses to decide.
3. The sink MUST NOT render a control register.
4. The sink MUST NOT verify graph lineage between node inputs and node outputs. It holds the artifacts that lineage rules reference.
5. A dashboard MUST be a view over stored records. It MUST NOT be the record.
