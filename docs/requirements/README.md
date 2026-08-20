# Pensieve requirements

Formal, numbered project obligations live here as `<PREFIX>-NNN-<topic>.md` files.
Four prefixes divide the system by the component that must satisfy the obligation:

| Prefix | Component | Document |
| --- | --- | --- |
| `SRV` | Pensieve server — the evidence sink, store, and verifier | [SRV-001: Evidence Sink](./SRV-001-evidence-sink.md) |
| `CLC` | Collectors — the per-harness capture extensions | [CLC-001: Harness Collectors](./CLC-001-harness-collectors.md) |
| `CICD` | CI/CD — the forge gates that consume evidence | [CICD-001: Evidence Gates](./CICD-001-evidence-gates.md) |
| `RTR` | Pensieve server — the read path over stored evidence | [RTR-001: Evidence Retrieval](./RTR-001-evidence-retrieval.md) |

A requirement belongs to the component that can fail it. A rule about what a
record must contain is `SRV` when the server rejects a malformed record, and
`CLC` when only the collector can produce the field.

`RTR` is the one prefix that does not name a distinct component — the server
satisfies it, as it does `SRV`. It is separate because ingest and retrieval fail
independently and at different times. A store can accept every record correctly
for a year and still be unreadable, and no `SRV` statement describes that
failure.

## Status

Implementation stage, 2026-08-11. `SRV-001` and `CLC-001` have running
implementations and deployed sinks; `CICD-001` and `RTR-001` do not yet. Only
some statements are pinned by tests, so a statement's presence here is not
evidence that it holds.

The usage-accounting fields in `SRV-001.13` and `CLC-001.9` are specification
only as of 2026-08-16. No collector, server route, persisted schema, or test
proves those fields yet.

## Statement format

Each document contains numbered sections `<PREFIX>-NNN.M`. Each section
contains a numbered list of statements. A statement is cited as
`<PREFIX>-NNN.M.K` — for example `SRV-001.5.3`.

Statements use RFC 2119 keywords: MUST, MUST NOT, SHOULD, SHOULD NOT, MAY.

Once an implementation exists, a machine-verifiable statement is pinned by a
test that carries a traceability comment:

```
THIS TEST VALIDATES A HARD REQUIREMENT (SRV-001.5.3)
YOU MUST NOT MODIFY THIS TEST UNLESS THE REQUIREMENT CHANGES
```

## Amending requirements

When reality and a requirement disagree, change the requirement first.

1. **Amend the requirement file.** Never renumber or reassign an existing
   section or statement ID. Replace a withdrawn statement in place with
   `REQUIREMENT REMOVED (YYYY-MM-DD): <rationale>`. Append new statements to
   the end of the list. Add an `Amendment (YYYY-MM-DD): ...` note under the
   section heading.
2. **Then update the pinned tests.** The amendment note authorizes touching a
   test marked "must not modify".
3. **Then change the implementation**, in the same change set.

The requirement edit, the test edit, and the implementation edit land
together, so the diff shows the whole trace.

## Parameter changes

Several statements carry organization-set parameters: retention floors,
freshness windows, the coverage epoch, and the required artifact classes.
Per [CICD-001.8](./CICD-001-evidence-gates.md), a parameter change that
tightens a control MAY land in an ordinary change. A parameter change that
loosens a control SHOULD land in an isolated, individually reviewed change
that does nothing else.

## Related design

- [RFC: Outfitter Governance](https://github.com/ai-outfitter/outfitter/issues/253) — control obligations, the evidence ledger, and the control register. Pensieve implements the storage half; the RFC owns the policy half.
- [Example repository](../../code/example-repo/README.md) — working shape of the CICD gates as GitHub workflows and rulesets.
