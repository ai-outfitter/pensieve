# Pensieve requirements

Formal, numbered project obligations live here as `<PREFIX>-NNN-<topic>.md` files.
Three prefixes divide the system by the component that must satisfy the obligation:

| Prefix | Component | Document |
| --- | --- | --- |
| `SRV` | Pensieve server — the evidence sink, store, and verifier | [SRV-001: Evidence Sink](./SRV-001-evidence-sink.md) |
| `CLC` | Collectors — the per-harness capture extensions | [CLC-001: Harness Collectors](./CLC-001-harness-collectors.md) |
| `CICD` | CI/CD — the forge gates that consume evidence | [CICD-001: Evidence Gates](./CICD-001-evidence-gates.md) |

A requirement belongs to the component that can fail it. A rule about what a
record must contain is `SRV` when the server rejects a malformed record, and
`CLC` when only the collector can produce the field.

## Status

Design stage, 2026-08-07. These documents specify intended behavior. No
implementation exists yet, so no statement is pinned by a test.

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
