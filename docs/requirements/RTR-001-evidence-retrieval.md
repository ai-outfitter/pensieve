# RTR-001: Evidence Retrieval

## Overview

Pensieve's ingest path is complete: a session is captured, sealed, and written
once into a store that cannot rewrite it. This document specifies the other
half — reading it back.

> **As** the person accountable for what an agent did,
> **I want** to find and read the transcript of any past session — by session,
> repository, commit, or time window —
> **so that** a claim about an agent's work can be checked against the bytes it
> actually produced, by someone who does not trust the process that wrote them.

Retrieval is not a view or a dashboard. A dashboard is a product decision built
over this record; retrieval is the record being reachable at all. The
distinction that governs this document is the same one in the project README: a
question answerable by reading bytes and checking a signature belongs here.

Two properties make retrieval a requirement rather than a convenience.

**An unreadable store is an unfalsifiable claim.** Evidence nobody can fetch
cannot contradict a summary, which is the single function the store exists to
perform.

**A caveat that cannot be read is an overclaim.** The sink already records
whether a record was observed live or backfilled by an importer. If a reader
cannot see that field, the store presents backfilled bytes and observed capture
as the same thing — and they are not the same thing at all.

## Current state, 2026-08-11

The ocean deployment holds 2003 payloads (~1.3 GiB) under S3 Object Lock in
COMPLIANCE mode, of which 2001 are backfilled Claude Code transcripts.

| Obligation | State |
| --- | --- |
| Read a record by digest | met — `GET /v0/records/<digest>` |
| Read a payload by digest | **unmet** — no route; bytes are reachable only with direct store credentials |
| Find a session without a digest | **unmet** — the index carries no session, identity, or repository dimension |
| Resolve a commit or patch to evidence | met — `GET /v0/commits/<sha>`, `GET /v0/patches/<id>` |
| Byte integrity on read | met — the store re-hashes and refuses a mismatch |
| Retention provable on read | met — the object reports `COMPLIANCE` and a retain-until date |
| Observed capture distinguishable from import | recorded, **not reachable** — depends on RTR-001.2 |

## Requirements

### RTR-001.1: Retrieval by Digest

1. A principal holding a payload digest MUST be able to retrieve the payload bytes over the sink API.
2. The sink MUST re-hash payload bytes on read and MUST fail the request rather than return bytes whose digest does not match the requested one.
3. A payload response MUST carry the content type recorded at seal time, and MUST NOT infer one from the bytes.
4. A payload response MUST report the object's storage locator, lock mode, and retain-until date, so a reader can reach its own conclusion about immutability without store credentials.
5. Retrieval of a payload MUST NOT require credentials for the underlying store. A reader who must be handed store credentials to read evidence has been handed the ability to write it.
6. A record response MUST include, or link by digest, the storage statement covering it.
7. A request for a digest the sink does not hold MUST return 404 and MUST NOT distinguish "never written" from "written and disposed" in the status code alone. The distinction belongs in the body, as a disposition event.

### RTR-001.2: Discovery Without a Digest

1. A reader MUST be able to enumerate sessions without possessing any digest in advance.
2. The index MUST support selection by agent identity, by repository, and by a time window over the record's `created_at`.
3. A listing entry MUST carry enough to fetch the underlying record and payload: the record digest, the payload digest, the kind, the identity, and the creation time.
4. A listing MUST be paginated by a stable, opaque cursor. Offset paging over an append-only index is not stable under concurrent ingest.
5. A listing MUST NOT return a record the requesting principal may not read.
6. A listing SHOULD be reachable from a commit or patch identity, so a reviewer can move from a diff to the session that produced it in one step.

### RTR-001.3: Provenance Visibility

1. Every listing entry and every record response MUST state whether the record was observed by a collector at the time of the session, or backfilled by an importer afterward.
2. A backfilled record MUST NOT be presentable as an observed one at any layer of the read path, including summaries and counts.
3. A backfilled record MUST carry the origin it was imported from, and MUST NOT carry an install scope. Nothing observed the session, so no scope is truthful.
4. A reader MUST be able to filter a listing to observed records only.
5. Where a record declares capture gaps, the read path MUST surface them alongside the record. A gap discoverable only by fetching and parsing the payload is not surfaced.

### RTR-001.4: Absence

1. The read path MUST distinguish three states: evidence exists; evidence was expected and is absent; nothing was expected.
2. Absence MUST read as unattested. It MUST NOT read as clean, and MUST NOT be reported as a passing state.
3. A query that cannot be answered because a backing store is unreachable MUST report an error. It MUST NOT return an empty result, which a caller cannot tell from "nothing matched".

### RTR-001.5: Authorization and Exposure

1. Read and write MUST be separately authorized. A principal that may read evidence MUST NOT thereby be able to write it.
2. Until identity is exchanged rather than self-asserted (SRV-001.2.2), a deployment whose network boundary is its only control MUST NOT expose the read path beyond that boundary, and its documentation MUST state that the boundary is the control.
3. A presigned URL issued for reading MUST be scoped to one object, MUST be read-only, and MUST expire.
4. The read path MUST NOT be able to mutate, delete, or shorten the retention of anything it serves.

### RTR-001.6: Verification by a Reader

1. A reader MUST be able to verify a record end to end using only the sink's published verification key and the bytes returned: the record digest, the signature over it, the payload digest, and the storage statement.
2. Verification MUST NOT require trusting the process that wrote the record, the collector that produced it, or the host it ran on.
3. A sink reporting itself non-conforming MUST report that on every read response, not only on `/health`. A reader that fetched one record must not have to have asked a separate question to learn the sink signs nothing.

## Open design questions

These are not requirements. They are the decisions RTR-001 will force.

- **Payload size.** Transcripts here reach tens of megabytes. Whether the sink streams bytes or redirects to a scoped presigned read URL changes RTR-001.1.5 from a property of the route to a property of the URL it issues.
- **Index dimensionality.** The current index is keyed for coverage lookups — commit and patch. Adding identity, repository, and time is a schema change over an append-only store, so it needs a rebuild path from the records themselves rather than a migration of the index in place.
- **Redaction on read.** Nothing may be removed from a WORM store. A reader who must not see a secret in a stored transcript can only be served a derived object. That is a `derivation` record, not an edit, and it is out of scope here.
