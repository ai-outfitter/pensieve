# CICD-001: Evidence Gates

## Overview

Four gates consume Pensieve evidence. Three can prevent; one cannot.

| Tier | Gate | Power |
| --- | --- | --- |
| 1 | Pull request, and merge queue | preventive |
| 2 | Default-branch landing and linkage | detective |
| 3 | Release | preventive |
| 4 | Deployment | preventive |

Tier 2 cannot block, because the commit is already on the branch when it runs.
Its output is enforced by tier 3: an uncovered commit costs nothing until
someone ships it, and then it stops the release. Each tier's failure is
enforced by the next tier's gate. That is why there are four and not one.

A working shape of every gate in this document is in
[`code/example-repo/`](../../code/example-repo/README.md).

## Requirements

### CICD-001.1: Gate Placement and Authority

1. A required evidence check MUST be required by a forge ruleset or branch protection that names the check and the identity permitted to report it.
2. A workflow file alone MUST NOT be treated as the control. A branch that can add or omit a workflow can route around it.
3. A workflow that implements a gate MUST be resolved from the default branch, not from the ref under review.
4. A gate job MUST NOT execute repository code. It MUST NOT run a build, an install, a test, or a script from the ref it judges.
5. A gate job MAY check out repository history for git object access, with credential persistence disabled and submodules disabled.
6. Every action a gate job uses MUST be pinned by commit digest.
7. The sink address and the sink verification key MUST be resolved from organization-level configuration. They MUST NOT be resolved from a file on the ref under review.
8. A repository-level policy file MAY tighten the organization policy. It MUST NOT loosen it.
9. A required check MUST report a conclusion on every event that can satisfy the rule. A check that reports on only some events leaves a pending status that blocks merges it was never meant to judge.

### CICD-001.2: Tier 1 — Pull Request and Merge Queue

1. For every commit in the range under review, a sealed `commit-evidence` record MUST exist that binds that commit's SHA and tree.
2. A commit with no record MUST fail the check.
3. A commit whose record is `failed-evidence` MUST fail the check.
4. Every referenced storage statement MUST meet the repository's retention floor, and the check MUST verify payload availability against the store.
5. The check MUST run on the merge-queue event as well as the pull-request event wherever a merge queue is enabled, because the queue merges content the pull-request check never saw.
6. The check MUST use the same check name across both events, or the rule will never be satisfied in the queue.
7. The check MUST re-verify the full range after a force push. It MAY verify incrementally otherwise.
8. The policy MUST declare what a human-authored commit requires. A commit outside every declared authorship rule MUST fail.
9. The check MUST publish a per-commit result — evidence identifier, acting identity, environment, policy digest, and declared gaps.
10. The check MUST bind its conclusion to the exact head SHA it verified, and the ruleset MUST require re-evaluation when the head moves.
11. On a release pull request, the check MUST additionally verify coverage across the full range the release would cover, and MUST report success without enforcement on a pull request that is not a release.

### CICD-001.3: Tier 2 — Landing and Linkage

1. Every update to a protected ref MUST produce a landing record.
2. The landing record MUST link the landed commits to the `commit-evidence` records that cover them, so that a later coverage query is one lookup rather than a re-derivation.
3. A squashed commit MUST be covered by the set of authored commits it absorbed, verified per SRV-001.7.
4. A merge-queue commit MUST be attributed `forge-generated`, MUST record the base and head inputs it combined, and MUST be verified by recomputation.
5. Tier 2 MUST NOT be relied on to prevent. It runs after the ref moved.
6. Completeness MUST come from scheduled reconciliation, not from the event that triggered the job.
7. A reconciliation finding MUST have an owner and MUST appear in the control register.

### CICD-001.4: Tier 3 — Release

1. A release MUST NOT be created while any commit in its range is uncovered, unless that commit carries a declared exemption.
2. The release gate MUST produce a release bundle per SRV-001.9 and MUST store it before the release is published.
3. Tag creation for a release tag pattern MUST be restricted by ruleset to the release automation identity.
4. Tag update and tag deletion MUST be blocked for a release tag pattern.
5. The release bundle digest MUST be attached to the release.
6. The release bundle SHOULD additionally be attested with the forge's native attestation mechanism. An attestation is corroboration. It MUST NOT be treated as a retention receipt.

### CICD-001.5: Tier 4 — Deployment

1. A deployment MUST verify the release bundle for the artifact it is about to deploy, before it deploys.
2. The deployment gate MUST re-verify coverage, storage-statement locks, and bundle freshness. It MUST NOT rely on the release gate's earlier verdict.
3. Where the forge supports a custom deployment protection rule, the gate MUST be implemented as that rule, because it then sits outside the workflow it judges.
4. Where the forge does not, the gate MUST be the first step of the deployment job, and the deployment SHOULD require a human to start it.
5. A human-initiated deployment MUST be shown the coverage report before the deployment starts.
6. Deployment is the last gate and MUST be the strictest, because it is the only gate whose failure has effect outside the forge.

### CICD-001.6: Authentication

1. A gate MUST authenticate to the sink with a workload identity token issued to the CI job.
2. A gate MUST NOT use a long-lived secret stored in the repository.
3. A gate MUST receive read-scoped credentials only.
4. A gate MUST NOT be able to write evidence. Evidence enters under the acting identity of the session that produced it.

### CICD-001.7: Failure Semantics

1. A gate MUST fail closed. An unreachable sink MUST fail the check. It MUST NOT skip it.
2. A gate MUST NOT report unknown as conforming.
3. A run that reached its emergency failure sink MUST fail the gate and MUST remain auditable. A run with no records at all MUST be indistinguishable from an agent that never ran, and MUST therefore also fail.
4. A break-glass path MAY exist. It MUST require a named human identity, and it MUST itself produce an evidence record.
5. A break-glass use MUST appear in the control register and MUST NOT be silently consumed.
6. The organization MUST accept that fail-closed on a merge queue stops merging for every contributor while the sink is unreachable, and MUST operate the sink accordingly.

### CICD-001.8: Coverage Epoch and Ratchet

1. Every repository MUST declare a coverage epoch: the commit from which evidence is required.
2. A commit before the epoch MUST be attributed `exempt` with the named epoch rule, and MUST NOT be reported as covered.
3. Every exemption MUST name the policy rule that grants it. A silent absence MUST NOT be treated as an exemption.
4. The coverage floor MAY rise. It MUST NOT fall in the ordinary course.
5. A change that lowers the coverage floor SHOULD land in an isolated, individually reviewed change that does nothing else.
6. A change that lowers the coverage floor MUST NOT land in the same change that a gate rejected.

### CICD-001.9: Forge Portability

1. The gates MUST NOT depend on a forge's merge-strategy behavior. The landing record measures what actually landed, so a forge that changes its queue or squash mechanics changes classification inputs, not the model.
2. Where the forge supports a pre-receive hook, the obligation "every commit on a protected ref carries evidence" MUST compile to a pre-receive hook that rejects an uncovered push.
3. Where the forge does not support a pre-receive hook, that obligation MUST compile to a ruleset that forbids direct pushes to the protected ref. There is no third option, and "verify direct pushes" MUST NOT be presented as a preventive control on such a forge.
4. Force pushes to a protected ref MUST be blocked by ruleset where the forge supports it, and MUST be recorded as a history rewrite where it does not.
5. A forge without an environment protection mechanism MUST implement tier 4 per CICD-001.5.4.
