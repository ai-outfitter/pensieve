# CLC-001: Harness Collectors

## Overview

A collector captures what an agent session does and forwards it to the sink.
One collector exists per harness. Each uses that harness's native extension
channel, and all of them emit the same record shapes.

A collector is deterministic plumbing. It makes no model call and takes no
decision that the session it observes can influence.

Harness capability differs, and the difference is measured rather than
asserted. Where a harness cannot capture a required artifact class, the
collector declares the gap. A declared gap fails a gate. An undeclared gap is
the failure this component exists to prevent.

## Requirements

### CLC-001.1: General Obligations

1. A collector MUST NOT call a model.
2. A collector MUST NOT take a capture decision that the observed session can change at run time.
3. A collector MUST forward records under the acting identity of the session it observes.
4. A collector MUST NOT alter a record after it forwards it.
5. A collector MUST emit the same record shapes as every other collector, so that the sink and the gates stay harness-independent.
6. A collector MUST NOT depend on the agent to report its own actions. It MUST observe the harness event surface.
7. A new harness MUST be addable as a new collector without a change to the sink.

### CLC-001.2: Installation and Authority

1. A collector MUST be installable at the harness's managed, system-root scope where that scope exists.
2. A collector installed at managed scope MUST be resolved ahead of user, project, and session configuration.
3. A collector MUST record its own install scope — `managed`, `user`, `project`, or `session` — in every session record it produces.
4. A verifier MUST be able to read the install scope and decide whether collection was authoritative or advisory. A collector MUST NOT report an advisory installation as authoritative.
5. A collector MUST record the harness name, the harness version, and the observable invocation arguments in its session record.
6. Where a harness supports a managed-only mode that ignores user and project hook configuration, the organization SHOULD enable it, and the collector MUST record whether it was in force.
7. Where a harness offers no managed scope, the organization MUST treat the launcher as the only install point, and the deployment MUST NOT present workstation collection for that harness as authoritative.

### CLC-001.3: Commit Segmentation

1. A collector MUST maintain a segment of session events bounded by commit boundaries.
2. A collector MUST seal a segment when it observes a commit, and MUST bind that segment to the resulting commit SHA, tree, parents, and patch id.
3. A collector MUST start a new segment immediately after it seals one.
4. A collector MUST retain events that fall outside any commit, in a terminal segment, when a session ends with uncommitted work.
5. A collector MUST NOT discard a segment because it produced no commit.
6. A collector MUST emit a `derivation` record when it observes an in-session history rewrite — an amend, a rebase, a squash, or a cherry-pick — and MUST record the prior and resulting commit identities.
7. A collector MUST treat each retry as a new attempt with its own session record, and MUST preserve the evidence of failed and cancelled attempts.

### CLC-001.4: Capture Profile and Completeness

1. A collector MUST load a capture profile that names the required artifact classes, the retention policy, the primary sink, and the emergency failure sink.
2. The first artifact classes are session records and transcripts, model requests and responses, tool calls and results, patches, images, logs, network exchanges, approvals, attestations, and SBOMs.
3. A collector MUST record which required classes it captured and which it did not.
4. A collector MUST declare a gap for any required class the harness cannot expose. It MUST NOT omit the class silently.
5. A segment with an unmet required class MUST be sealed `failed-evidence`.
6. A collector MUST NOT downgrade a required class to optional at run time.

### CLC-001.5: Redaction and Prohibited Material

1. A collector MUST apply the redaction rules of its capture profile before it forwards a payload.
2. A retained network body MUST carry a mediated-capture statement and a secret-scan statement.
3. A collector MUST NOT capture material the profile prohibits, and MUST NOT rely on later deletion.
4. A collector MUST fail to start when its profile's retention obligation conflicts with a declared privacy or residency rule.
5. A collector MUST record that a redaction occurred, including the rule that caused it, without recording the redacted content.

### CLC-001.6: Delivery

1. A collector MUST buffer records durably on local disk before it forwards them.
2. A collector MUST NOT drop a record because the sink is unreachable.
3. A collector MUST forward buffered records in order once the sink is reachable.
4. A collector MUST support deferred upload for offline and air-gapped sessions through an explicit push command.
5. A collector MUST write a signed minimal capture-failure record to the emergency failure sink when the primary sink fails, and MUST stop the route it was capturing.
6. A collector MUST NOT forward evidence through a CI job on behalf of a session that ran elsewhere.
7. An agent that runs inside CI is not an exception to CLC-001.6.6: its acting identity is the runner's workload identity, and the collector MUST forward under that identity.

### CLC-001.7: Harness Projections

1. Each collector MUST be implemented against the harness's native extension channel:

   | Harness or surface | Channel |
   | --- | --- |
   | Claude Code | hook entries in managed settings; command or HTTP handlers |
   | Codex | lifecycle hooks from a managed source |
   | Pi | an extension package loaded at session start |
   | Gemini CLI | hook entries plus admin policy |
   | GitHub and Forgejo Actions | a step pinned by digest |
   | Kubernetes | an operator-mounted sidecar with a short-lived workload identity |
   | Any other | a process wrapper that captures stdio and process metadata |

2. A collector for a harness whose hooks do not expose model requests and responses MUST declare the `model-exchange` class as a gap. A conversation transcript MUST NOT be recorded as satisfying that class.
3. A collector MUST prefer an in-process event surface over a reconstructed one where the harness provides both.
4. A collector MUST record the exact event surface it used, so that a coverage report is computed from what ran rather than asserted from documentation.

### CLC-001.8: Bypass

1. A collector MUST record every harness invocation argument it can observe, including arguments that disable extensions or hooks.
2. A collector cannot report a session in which it never ran. Absence of a session record MUST therefore be treated by the sink and the gates as unattested, never as clean.
3. Where a harness offers a flag that skips hooks or extensions, the organization SHOULD compile a control that blocks that flag, and the deployment MUST record whether such a control is in force.
4. A collector MUST NOT be disableable from inside the session it observes when it is installed at managed scope.

### CLC-001.9: Usage Accounting Projection

> **Implementation status (2026-08-16):** These statements specify the target
> projection onto existing records. No collector implementation or test proves
> them yet.

1. A collector MUST project usage accounting onto the existing `model-exchange`, `tool-call`, and `session` record kinds defined by SRV-001.13.
2. A collector MUST preserve the provider's requested model and resolved model as separate values when its event surface exposes both.
3. A collector MUST emit `null` for a usage counter that its event surface does not expose. It MUST name that counter in `usage_gaps`.
4. A collector MUST NOT infer a zero token count or zero cost from an absent provider field.
5. A collector MUST preserve provider-reported cost, amount, and currency without replacing them with a price-book estimate.
6. A collector MAY derive a price-book estimate only when it records the source and effective date and labels the result as estimated.
7. A collector MUST assign a new attempt number to each retry that it can observe.
8. A collector MUST preserve the parent run and delegation lineage for each delegated session that it can observe.
9. A collector MUST record workload identity, substrate, schedule, workflow run, generated artifacts, start, end, and terminal status when its event surface exposes them.
10. A collector MUST declare a session gap for each required session field that its event surface cannot expose.
11. A collector MAY record billable tool quantity, unit, or cost when the tool event exposes it.
12. A collector MUST leave unreported tool cost unknown. It MUST NOT report the tool as free.
