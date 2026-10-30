# EVL-001: Evaluation Bundles

> **Status: proposed standard (`pensieve.evaluation/v0`), 2026-10-30.** The
> field names and layout are stable enough to build against; statements may
> still be amended under the usual rules before v1.

## Overview

An agent-workflow evaluation is only as good as the evidence it leaves. A
score with no saved inputs, outputs, prompts, and model settings cannot be
re-checked, and two scores with different hidden variables cannot be compared.

An **evaluation bundle** is a directory that holds one evaluation run: the
cases it used, what it observed, how each check scored it, and a manifest that
binds all of it by digest. `@pensieve/eval` (`code/eval/`) writes bundles,
validates them offline, and compares two of them.

What a bundle proves, and what it does not:

- A manifest digest proves the **integrity of what was saved**: the bytes on
  disk are the bytes the manifest names. It does not prove the run executed as
  described, and it is not an independent attestation.
- A bundle on a local disk or in a Git repository has **no retention
  guarantee**. A Git commit is publication, not retention: history can be
  rewritten and repositories deleted. Retention is what an Object Lock sink
  statement ([SRV-001](./SRV-001-evidence-sink.md)) proves, and a bundle only
  carries that proof if a receipt is attached.
- Receipts are optional and live **outside** the manifest, in `receipt.json`,
  because a statement over the manifest digest cannot also be inside the
  manifest.

## Layout

```
<run-id>/
  manifest.json                  canonical JSON, the only index
  receipt.json                   optional: { manifest_digest, statements[] }
  report.md                      human summary
  cases/<case-id>/input.json     inputs the case used
  cases/<case-id>/output.json    observed outputs, {} when none
  cases/<case-id>/trace.json     ordered operations: model calls, step changes, reads, writes
  cases/<case-id>/checks.json    per-check results
  prompts/<step>.txt             exact resolved prompts sent, one per agent step
```

The manifest schema is the TypeScript `Manifest` type in
[`code/eval/src/types.ts`](../../code/eval/src/types.ts).

## Requirements

### EVL-001.1: Layout and Manifest

1. A bundle MUST be a directory named by its run id, and `manifest.json` MUST be its only index.
2. `manifest.json` MUST be byte-identical to the UTF-8 encoding of Pensieve's `canonicalize` of the manifest (SRV-001.3.3): no byte-order mark, no whitespace.
3. `manifest.standard` MUST name a standard the validator knows. A validator MUST reject an unknown standard rather than guess.
4. Every file in the bundle other than `manifest.json` and `receipt.json` MUST be listed in `manifest.artifacts` with its path, SHA-256 digest of the exact bytes, size, and media type.
5. JSON artifacts SHOULD be written as canonical JSON so that writing the same inputs twice produces byte-identical files.
6. A manifest MUST NOT contain fields the standard does not define, except inside `model.configuration`. A validator MUST reject unknown fields rather than ignore them.
7. Timestamps MUST be ISO-8601 date-times with an explicit offset, and `run.ended_at` MUST NOT be earlier than `run.started_at`.
8. `subject.definition_digest` MUST be the canonical digest of the subject's definition with every prompt text listed in `prompts` removed, so that a prompt change never moves it and any other definition change does.

### EVL-001.2: Integrity

1. A validator MUST fail a bundle in which a listed artifact is missing, or its size or digest does not match.
2. A validator MUST fail a bundle that contains a file not listed in `manifest.artifacts`.
3. An artifact path MUST be relative, MUST NOT contain `..`, empty, or `.` segments, and MUST NOT resolve outside the bundle, including through a symbolic link.
4. Every artifact a result or prompt names MUST be listed, a prompt's digest MUST equal its artifact's digest, and no two prompts MAY name the same step.
5. Every result case and gap case MUST be in `dataset.cases`, and every check's scorer MUST be in `scorers`.
6. Every result MUST carry exactly one check for each declared scorer. A scorer that does not apply to a case records `not-applicable`, and one not yet scored records `pending`.

### EVL-001.3: Modes

1. A manifest MUST declare exactly one mode: `recorded` (replayed model responses), `real-model` (a live model against synthetic or recorded connectors), or `live-provider` (a live model against real provider connectors).
2. A `recorded` manifest MUST have `model.kind = recorded`, MUST NOT name a model provider or model id, and MUST carry a recordings digest.
3. A `real-model` or `live-provider` manifest MUST have `model.kind = provider`, MUST name the provider and model id, and MUST NOT carry a recordings digest.
4. A bundle summary and a comparison report MUST state the mode of each run, and MUST NOT present one mode as another.

### EVL-001.4: Run Status and Append-Only Writing

1. A run's status MUST be one of `running`, `complete`, `failed`, or `interrupted`.
2. A `complete` run MUST have an `ended_at` and exactly one result for every dataset case. A `running` run MUST NOT have an `ended_at`.
3. Summary counts MUST equal the counts of result statuses.
4. A case's status MUST follow from its checks: `pass` needs at least one passing check and no failed, errored, or pending check; `fail` needs at least one failed check; `error` needs at least one errored check; and a case with an errored check and no failed check MUST be `error`.
5. A writer MUST NOT write into an existing bundle directory. A rerun or regrade MUST be a new run id that refers to its predecessor through `run.previous` or `run.regrade_of`.
6. A writer MUST create a bundle with a `running` manifest and no results, MAY then add new artifacts, and MUST finalize it exactly once. Finalizing MAY set only the status, `ended_at`, results, gaps, the derived summary, and new artifacts, and MAY append prompt entries that only exist once cases have run, such as model-authored instructions. The run identity, mode, subject, dataset, scorers, model, and the prompts declared at creation are fixed. A writer MUST NOT rewrite an artifact already written, and MUST NOT change a bundle once its status is final.
7. `failed` and `interrupted` runs MUST be kept and MUST validate as what they are, not be hidden or replaced.
8. A writer MUST validate the manifest before every write and MUST refuse to write an invalid one. It MUST NOT write through a symbolic link inside the bundle, and MUST leave no temporary file behind on failure. A bundle has a single writer; concurrent writers are not supported.

### EVL-001.5: Receipts and Retention Claims

1. `receipt.json` is OPTIONAL. When present, its `manifest_digest` MUST equal the SHA-256 of the canonical manifest, and a validator MUST fail it otherwise. Anything else in the receipt, such as sink statements, is carried and not verified by this validator.
2. A tool MUST NOT describe a bundle as retained, attested, or tamper-proof on the strength of its manifest digest or a Git commit alone.
3. A retention claim MUST rest on a sink storage statement in `receipt.json` that a verifier can check against the sink.

### EVL-001.6: Publication

1. A bundle published outside the evaluating machine (committed, attached, or shared) MUST pass the publication profile.
2. The publication profile MUST reject credential-looking strings — API keys, access tokens, bearer tokens, private keys — in any file of the bundle and in any file path.
3. The publication profile MUST require `subject.source.dirty = false`, so the evaluated source is a commit anyone can check out.
4. The publication profile MUST reject a non-empty string under a secret-like key — `api_key`, `token`, `secret`, `password`, `authorization`, matched case-insensitively and ignoring separators — in the manifest and in any JSON artifact.

### EVL-001.7: Comparison

1. Two bundles MUST be compared only when they declare the same standard and mode, the same subject kind, id, and source repository, the same `dataset.digest` and `dataset.cases`, and the same set of scorer id and version pairs. Otherwise a comparison MUST report them as not comparable and MUST NOT tally any case.
2. A comparison MUST report every provenance field that differs between the runs: subject version, definition digest, source commit, dirtiness, and paths, prompt digests, and model provider, id, configuration, and recordings.
3. When a candidate declares `change`, a comparison MUST flag every difference the declared variable does not cover. A run that changes more than it declares is not an experiment on that variable. What each variable covers is the `CHANGE_COVERS` table in [`code/eval/src/compare.ts`](../../code/eval/src/compare.ts).
4. Errors, skipped cases, and missing results MUST NOT be counted as passes or as regressions. They MUST be reported separately.

### EVL-001.8: Portability

1. Validation and comparison MUST run offline, with no model, provider, or network access.
2. The manifest, comparison, and in-memory bundle validation code MUST run unchanged under Node, Bun, and Cloudflare Workers. Filesystem access MUST live in a separate module.
3. A validator MUST NOT throw on malformed input. It MUST report a manifest that is not an object, holds non-JSON values, exceeds 8 MiB, or nests deeper than 32 levels as an issue.

The package ships TypeScript source with erasable syntax only. Consumers load it through a workspace or submodule path with Bun, tsx, Node's type stripping, or a bundler.
