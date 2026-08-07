# Example repository

A working shape of the four evidence gates specified in
[CICD-001](../../docs/requirements/CICD-001-evidence-gates.md). Copy the
`.github/` tree into a repository, replace every marked placeholder, and import
the two rulesets.

> **Status:** design stage, 2026-08-07. The `ai-outfitter/pensieve/actions/*`
> actions referenced here do not exist yet. Every `@0000…0000` is a placeholder
> for a real 40-character commit digest.

## What is here

| File | Tier | Power |
| --- | --- | --- |
| `.github/workflows/evidence-pr.yml` | 1 — pull request and merge queue | preventive |
| `.github/workflows/evidence-main.yml` | 2 — landing and linkage | detective |
| `.github/workflows/evidence-reconcile.yml` | 2 — completeness | detective |
| `.github/workflows/release.yml` | 3 — release | preventive |
| `.github/workflows/deploy.yml` | 4 — deployment | preventive |
| `.github/rulesets/default-branch.json` | — | the actual control |
| `.github/rulesets/release-tags.json` | — | the actual control |
| `.github/pensieve.yml` | — | repository policy; may tighten, never loosen |

## The rulesets are the control, not the workflows

A workflow a branch can add or omit is not a gate. The ruleset requires the
check by name and controls who may report it. Import them with:

```sh
gh api -X POST /repos/{owner}/{repo}/rulesets --input .github/rulesets/default-branch.json
gh api -X POST /repos/{owner}/{repo}/rulesets --input .github/rulesets/release-tags.json
```

Two things to set before importing:

- `release-tags.json` has `actor_id: 0`. Replace it with the app ID of your
  release automation. The `creation` rule blocks tag creation for everyone
  except that bypass actor, which is what restricts release tags to the release
  workflow. Note the bypass is `always`, so that actor also bypasses `update`
  and `deletion` — narrow it if your forge plan supports a finer mode.
- `default-branch.json` has `bypass_actors: []`. Leave it empty. An
  organization that needs a break-glass path should use the recorded
  break-glass in `.github/pensieve.yml`, not a silent ruleset bypass.

The `pull_request` rule in `default-branch.json` is doing more work than it
looks like. On github.com there is no pre-receive hook, so the obligation
"every commit on `main` carries evidence" has exactly one preventive
compilation: forbid direct pushes. Requiring a pull request *is* the direct-push
control. On Forgejo, GitLab, or GitHub Enterprise Server, compile it to a
pre-receive hook instead and direct pushes can be verified rather than banned.

## Four things that will bite you

**One check name across two events.** `evidence/commits` must report on both
`pull_request` and `merge_group`. A rule requiring a check that the queue never
reports leaves a permanently pending status, and nothing merges.

**A required check must always report.** The release-range verification is a
second *step* in the same job rather than its own job, precisely so it always
reports a conclusion. If it were a separate required job that only ran on
release pull requests, every ordinary pull request would sit pending forever.

**The gate job runs no repository code.** For `pull_request`, GitHub reads the
workflow definition from the default branch, so the ref under review cannot
edit the gate — but it *can* edit the code the job checks out. A verifier that
runs an install script from the branch it judges is not a verifier. Checkout is
history-only, with credentials not persisted and submodules off.

**Squash merge is the default and it breaks naive binding.** release-please
recommends squash merges, and a squashed commit is a new SHA claimed by no run.
Coverage on `main` resolves through the landing records written by
`evidence-main.yml`, which bind the landed commit to the authored commits it
absorbed. Without tier 2, `main` fails its own gate the first time anyone
verifies retroactively.

## Setup

Organization-level variables, so no value the gate trusts comes from the ref
under review:

| Variable | Value |
| --- | --- |
| `PENSIEVE_SINK` | Base URL of the sink |
| `PENSIEVE_SINK_KEY` | Pinned verification key, or its locator |

No secret is required. Every job authenticates with an OIDC workload identity
token and receives read-scoped, short-lived credentials. Gates cannot write
evidence — evidence enters the sink under the acting identity of the session
that produced it, never uploaded from CI.

Then set the coverage epoch in `.github/pensieve.yml` to the commit you are
adopting from. Everything before it is exempt by the named `pre-epoch` rule.
Skip this and your first release fails on ten years of history.

## Deployment gate

The authoritative tier-4 gate is a **custom deployment protection rule** — a
GitHub App bound to the `production` environment that approves or rejects the
deployment, and therefore sits outside the workflow it judges. The verify step
inside `deploy.yml` is defense in depth, and is the only available gate on a
forge with no environment protection mechanism. There, require a human to start
the deployment and show them the coverage report first.
