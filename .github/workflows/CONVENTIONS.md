# Release conventions: what gates a release, and where to look when one did not happen

How the pipelines in this directory decide that a commit may be published. The workflow files own the mechanism; this file owns the RULE, so the next person changing a trigger does not have to reconstruct from YAML why publication waits on another workflow.

Applies to both clients, because it is about the pair rather than either one. `release.yml` builds and publishes the desktop app (GitHub Releases, on the `dev` and `latest` update channels) and `mobile-pipeline.yml` builds and uploads the iOS client (TestFlight). `platforms-gate.yml` is the shared gate that couples them.

## ★ The rule: never release unless every build completes and every test passes, on every platform

A release waits on the WHOLE matrix. Not each platform's own jobs, and not a platform's word for it: **every build and every test in both pipelines, for the commit being released, must have finished successfully before anything is published anywhere.**

The rule is Abi's, on 2026-09-16: "never release unless all builds complete and are tested, that is the gate for a release".

Abi extended it the same day to make the symmetry explicit, and gave the reason: "phone side should not progress either if builds fail we do not want any releases making it out, it could mean an integration issue we need to resolve". So a failure anywhere means nothing makes it out, on any platform.

**The case it was written from, and the reason it is not a preference.** On one commit the desktop release concluded SUCCESS and published, while the mobile pipeline FAILED on a parity test. A release went out for a commit whose other platform was red, and nothing in either file could see it: `release.yml`'s release job required its own build matrix, `mobile-pipeline.yml`'s required its own test matrix, and both of those were satisfied on that commit by a workflow that had no idea the other existed. Each platform gated itself, so the pair was ungated. See the run history for `2026-09-16`, where three commits in a row show a green desktop release beside a red mobile pipeline.

### Why this is not per-platform, and why one direction is not enough

**A build or test failure on one platform can be an integration issue in the shared code, not a fault confined to the client that showed it.** The clients are a product monorepo: `core/` is compiled into both of them, while `desktop/` reaches only the desktop app and `mobile/` only the phone. A leg that goes red is therefore evidence about code BOTH clients run, and the platform that happened to pass is no evidence at all that the commit is safe to ship either client from.

That is what makes the gate a pair rather than two independent checks, and it is why a failure on either side stops BOTH publishes rather than only its own. Gating each platform on its own jobs publishes the half that passed while the shared code underneath it is unproven, and the red leg on the other side is exactly the signal that would have said so. So neither direction is a courtesy to the other and neither is optional: the desktop's release waits on the phone's build and tests, the phone's upload waits on the desktop's, and a leg that failed, was cancelled or timed out, a gate that cannot see the other platform at all, and a window that runs out all refuse.

## How the gate enforces it

Both pipelines call `platforms-gate.yml`, and both publish jobs need it:

| Pipeline | Waits on | Because |
|---|---|---|
| `release.yml` | `claw-mobile pipeline`, jobs matching `^iOS ` | a desktop release must not ship a commit the phone failed |
| `mobile-pipeline.yml` | `claw-desktop release`, jobs matching `^build` | a TestFlight upload must not ship a commit the desktop failed |

**Both directions, with no asymmetry.** Each client ships from its own pipeline, so a commit that broke one of them is not a commit to hand anyone either client from. There is nothing to weigh; the two directions are the same claim.

**Both directions are wired identically**, which is what makes that claim mechanical rather than a promise: each publish job lists the shared gate in its `needs` and asserts its result in its own `if`, so a refused gate skips the publish exactly as a failed leg of its own matrix does.

What the gate reads, and what it deliberately does not:

- **The other pipeline's build and test jobs**, every one of which must conclude `success`. A cancelled or timed-out leg is not a passing one, and is treated as a failure. A leg that was skipped is not evidence either: if every verdict job was skipped the gate reads the other run's own conclusion, so a version job that failed (which skips its matrix and fails its run) still refuses.
- **A run's job list lags the run itself.** A run object appears within seconds of its push while its jobs register seconds to tens of seconds later, so the gate waits for a matching job to appear rather than reading an empty list as a rename, and refuses on an empty match only once the other run has concluded without ever listing one. Reading the empty list as a verdict is what refused a release whose counterpart was green on 2026-09-17.
- **Not the other pipeline's publish job.** Each release job needs its own pipeline's gate, and each gate waits on the other pipeline's verdict, so waiting on its publish as well would deadlock both runs. The upload is not a build or a test either.

**Failure behaviour.** A phase that fails, is cancelled, or times out refuses in one direction only: nothing is published. The gate never publishes on behalf of the other platform, and it never turns a red verdict into a deferred one. In `release.yml` a failed gate skips the release job exactly as a failed build leg does, so no GitHub Release and no tag are created; in `mobile-pipeline.yml` it skips the upload, so no build reaches TestFlight.

**A platform this commit cannot affect has no run at all**, and that is a real answer rather than a fault: `desktop/` and `core/` build the desktop while `mobile/` and `core/` build the phone, so a commit confined to one client's own tree only builds that client. On a **tag** push the answer must not be read this way, because GitHub does not evaluate path filters for tags: a tag release runs both pipelines whatever changed, so a missing run there is a fault and the gate refuses. That is the case that actually ships to everyone.

## Where to look when a release did not happen

A release that silently does not happen is its own bug, so a refusal is written where the question gets asked rather than only into a log:

1. **The run list, first.** The gate job is named after what it waits for, so a blocked run reads `claw-mobile pipeline must be green` with a red mark, and the publish job beside it is skipped.
2. **The failing job's annotation**, which names every leg that was not green and links the other pipeline's run.
3. **Its step summary**, which says the same in one block: which platform, which jobs, which run.
4. **The other pipeline's run**, linked above, for the actual failure.

**Read the refusal for what it is pointing at, which is often shared code rather than the pipeline that refused.** The platform named in the gate job is the one that failed, not the one being blamed: when a leg goes red on a commit that did not touch that client's own tree, `core/` is where the shared half lives and where the integration fault usually is. A blocked release on either platform is the first evidence of that fault, not a formality to clear.

Two other things can block a publish, and neither is this gate:

- The **artifact gate** (`desktop/scripts/check-release-artifacts.js`) refuses a release whose platform is present but incomplete, meaning a missing installer or missing update metadata, when every build leg succeeded.
- The **version job** stands a build down for a commit covered by its own tag build, so no publish is expected at all.

## What this rule does not cover

Named so it is not mistaken for coverage.

- **A commit that only changes one client's tree is gated on that client only.** The gate keys on the commit being published, so if a `core/` change breaks the phone and the next commit touches only `desktop/`, the desktop release for that next commit is not blocked. The release that accompanies the breaking change is blocked, which is the case the rule was written from.
- **A manual `workflow_dispatch` of one pipeline** is a dev build of that platform on demand. It is still gated when the other pipeline happens to have run the same commit; when it has not, the gate reports that the other platform has no run and publishes. A tag release can never take that path, which is the one that reaches everyone.
- **A rolled-back or re-run publish** is not re-gated beyond the run it belongs to. A `gh run rerun` of a publish job re-reads the other pipeline's verdict as it stands at that moment.

## The files

| File | Owns |
|---|---|
| `platforms-gate.yml` | What "the other platform is green" means, and the refusal messages. Called by both pipelines. |
| `release.yml` | The desktop build matrix, the artifact gate, and the desktop release. |
| `mobile-pipeline.yml` | The iOS test matrix, the archive, and the TestFlight upload. |
| this file | The rule, the rationale for its two directions, and where to look. |
