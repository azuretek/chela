# Release conventions: what gates a release, and where to look when one did not happen

How the pipelines in this directory decide that a commit may be published. The workflow files own the mechanism; this file owns the RULE, so the next person changing a trigger does not have to reconstruct from YAML why publication waits on another workflow.

Applies to both clients, because it is about the pair rather than either one. `release.yml` builds and publishes the desktop app (GitHub Releases, on the `dev` and `latest` update channels) and `mobile-pipeline.yml` builds and uploads the iOS client (TestFlight). `platforms-gate.yml` is the shared gate that couples them.

## ★ The rule: never release unless every build completes and every test passes, on every platform

A release waits on the WHOLE matrix. Not each platform's own jobs, and not a platform's word for it: **every build and every test in both pipelines, for the commit being released, must have finished successfully before anything is published anywhere.**

The rule is Abi's, on 2026-09-16: "never release unless all builds complete and are tested, that is the gate for a release".

Abi extended it the same day to make the symmetry explicit, and gave the reason: "phone side should not progress either if builds fail we do not want any releases making it out, it could mean an integration issue we need to resolve". So a failure anywhere means nothing makes it out, on any platform.

**The case it was written from, and the reason it is not a preference.** On one commit the desktop release concluded SUCCESS and published, while the mobile pipeline FAILED on a parity test. A release went out for a commit whose other platform was red, and nothing in either file could see it: `release.yml`'s release job required its own build matrix, `mobile-pipeline.yml`'s required its own test matrix, and both of those were satisfied on that commit by a workflow that had no idea the other existed. Each platform gated itself, so the pair was ungated. See the run history for `2026-09-16`, where three commits in a row show a green desktop release beside a red mobile pipeline.

## ★ And only when something SHIPPED changed

Abi, 2026-09-18: "we only need a release if something actually changed, so docs and other things like that definitely do not need a release at all."

**A release happens only for a commit that changes something which ships.** This is a second rule rather than a restatement of the first, and it changed what the path filter was FOR: it used to decide whether a release **waited** for the other platform, and its answer for a commit confined to one client's tree was "publishing is unaffected". It now decides whether a release happens **at all**. The escape is gone, and so is the filter: the trigger set has one owner, `scripts/release/changes.mjs`, which both pipelines ask through a `changes` job and which a test holds them to (`desktop/test/release-trigger.test.js`, which fails if a `paths:` or `paths-ignore:` reappears anywhere under `on:`).

| | Release-triggering | Not |
|---|---|---|
| Paths | `core/` (compiled into both clients, spec and ui included), `desktop/`, `mobile/`, `package.json`, `pnpm-lock.yaml`, `pnpm-workspace.yaml` | `docs/`, `*.md`, `.github/`, `.githooks/`, `scripts/`, and `LICENSE` / `.gitignore` |
| What runs | both pipelines in full, nothing published until every leg and the TestFlight upload are green | CI still builds, tests and lints, and NOTHING publishes: no version bump, no GitHub Release, no TestFlight upload |

**The classification is exclusion rather than inclusion**: a path ships unless the list says otherwise, so a tree nobody thought about is treated as shipped and is gated by the whole matrix rather than being silently exempt. The two failure directions are not equally bad. Publishing a release for a commit that changed nothing costs a version number; a shipped fix that never reaches anyone costs the fix.

**A tag and a `workflow_dispatch` are an explicit "release this"**, so where they find nothing shipped the `changes` job REFUSES rather than standing down: a release that was asked for and quietly did not happen is its own bug. The range a tag or a dispatch is judged over is everything since the last release tag, because that is what it would ship, rather than only its tip commit.

**The two rules are what make the cost affordable.** A commit that ships now runs the whole matrix on BOTH platforms, a desktop-only commit included, because the release the desktop publishes is the feed the phone reads. That is why the mobile pipeline caches its generated project, its simulator build products and the Swift package caches: a commit that changes no iOS input restores those layers instead of rebuilding them.

### Why this is not per-platform, and why one direction is not enough

**A build or test failure on one platform can be an integration issue in the shared code, not a fault confined to the client that showed it.** The clients are a product monorepo: `core/` is compiled into both of them, while `desktop/` reaches only the desktop app and `mobile/` only the phone. A leg that goes red is therefore evidence about code BOTH clients run, and the platform that happened to pass is no evidence at all that the commit is safe to ship either client from.

That is what makes the gate a pair rather than two independent checks, and it is why a failure on either side stops BOTH publishes rather than only its own. Gating each platform on its own jobs publishes the half that passed while the shared code underneath it is unproven, and the red leg on the other side is exactly the signal that would have said so. So neither direction is a courtesy to the other and neither is optional: the desktop's release waits on the phone's build and tests, the phone's upload waits on the desktop's, and a leg that failed, was cancelled or timed out, a gate that cannot see the other platform at all, and a window that runs out all refuse.

## How the gate enforces it

Both pipelines call `platforms-gate.yml`, and both publish jobs need it:

| Pipeline | Waits on | Because |
|---|---|---|
| `release.yml` | `claw-mobile pipeline`, jobs matching `^iOS \|^swiftlint$\|^release$` | a desktop release must not ship a commit the phone failed, and must not go out before the TestFlight build is VALID |
| `mobile-pipeline.yml` | `claw-desktop release`, jobs matching `^build` | a TestFlight upload must not ship a commit the desktop failed |

**Both directions, with no asymmetry.** Each client ships from its own pipeline, so a commit that broke one of them is not a commit to hand anyone either client from. There is nothing to weigh; the two directions are the same claim.

**Both directions are wired identically**, which is what makes that claim mechanical rather than a promise: each publish job lists the shared gate in its `needs` and asserts its result in its own `if`, so a refused gate skips the publish exactly as a failed leg of its own matrix does.

What the gate reads, and what it deliberately does not:

- **The other pipeline's build and test jobs, and the upload**, every one of which must conclude `success`. Only `success` passes. A cancelled or timed-out leg is not a passing one, a **skipped** one is not evidence either, and a job the pattern cannot find at all refuses: a gate that cannot see what it waits for is not a gate.
- **A run's job list lags the run itself.** A run object appears within seconds of its push while its jobs register seconds to tens of seconds later, so the gate waits for a matching job to appear rather than reading an empty list as a rename, and refuses on an empty match only once the other run has concluded without ever listing one. Reading the empty list as a verdict is what refused a release whose counterpart was green on 2026-09-17.
- **Every alternative in a verdict, not whichever of them exist yet.** A verdict is a flat alternation of whole job-name patterns, and a run's job list is written as the run goes, so the jobs it names do NOT appear together: on 2026-09-21 the mobile run for `c8d9db5675` had `iOS 26`, `iOS 27` and `swiftlint` concluded `success` while its `release` job had not registered at all. `^iOS |^swiftlint$|^release$` is satisfied by that subset, so the desktop published, and the iOS marker step -- reading the same verdict a second later -- saw an empty conclusion, left the release unmarked, and no phone could be offered an update from it. A named job that has not appeared yet is a reason to WAIT, and a run that concludes without it refuses, the rule the empty match already follows. A verdict carrying a group refuses rather than guessing which patterns are named.
- **Not the other pipeline's publish job.** Each release job needs its own pipeline's gate, and each gate waits on the other pipeline's verdict, so waiting on its publish as well would deadlock both runs. The upload is not a build or a test either.

**Failure behaviour.** A phase that fails, is cancelled, or times out refuses in one direction only: nothing is published. The gate never publishes on behalf of the other platform, and it never turns a red verdict into a deferred one. In `release.yml` a failed gate skips the release job exactly as a failed build leg does, so no GitHub Release and no tag are created; in `mobile-pipeline.yml` it skips the upload, so no build reaches TestFlight.

**A missing run is a refusal, and so is a skipped job.** Both pipelines trigger on every path, so a commit that reaches the gate has always been built by the other one: a missing run means the trigger regressed or a run was never created, and the gate refuses rather than reading it as a platform this commit does not involve. A **skipped** job refuses for the same reason, and this is the half that matters most. The mobile `release` job is where the TestFlight upload and the wait for the build to reach VALID live, so a skipped upload means no installable iOS build exists, and the release published then is a feed entry pointing the phone at a build that is not there.

## Where to look when a release did not happen

A release that silently does not happen is its own bug, so a refusal is written where the question gets asked rather than only into a log:

1. **The run list, first.** The gate job is named after what it waits for, so a blocked run reads `claw-mobile pipeline must be green` with a red mark, and the publish job beside it is skipped.
2. **The failing job's annotation**, which names every leg that was not green and links the other pipeline's run.
3. **Its step summary**, which says the same in one block: which platform, which jobs, which run.
4. **The other pipeline's run**, linked above, for the actual failure.

**Read the refusal for what it is pointing at, which is often shared code rather than the pipeline that refused.** The platform named in the gate job is the one that failed, not the one being blamed: when a leg goes red on a commit that did not touch that client's own tree, `core/` is where the shared half lives and where the integration fault usually is. A blocked release on either platform is the first evidence of that fault, not a formality to clear.

## The iOS availability marker: a release the phone may offer names a version with a TestFlight build

The gate above stops a release from going out when a platform is red. It does NOT stop the phone from OFFERING a release that has no iOS build at all, and that is a different failure with the same shape: a desktop-only or `.github`-only commit produces a GitHub Release (the desktop builds) but no mobile pipeline run, so no TestFlight build, and the phone reads that release from the feed and points the user at a build that does not exist. Measured 2026-09-18: `v1.0.1-dev.279.9a58115cb1` (a `.github`-only change, PR #39) had no mobile run and was not on TestFlight, yet the in-app banner offered it.

**The rule: the iOS "update available" banner only ever names a version that has an installable TestFlight build.** The phone reads `releases.atom`, whose entries carry the release body as `<content>` but carry no assets, so the signal is a marker LINE in the release body rather than an asset: `release.yml`'s release job appends it (from `core/release.js`'s `iosMarkerLine()`, the one owner of the string) at publish time, and only when the mobile pipeline's `release` job concluded success for this commit. The feed readers (`core/feed.js` and `mobile/Claw/UpdateFeed.swift`) offer a release to the phone only when its entry carries that marker; the desktop reads every release, because its own installers are on any release it published.

**Why the marker is written by the desktop pipeline and not the mobile one.** The mobile `release` job finishes its wait for TestFlight VALID BEFORE the desktop publishes -- the platforms gate makes the desktop publish wait on the mobile `^release$` job, and the every-alternative rule above is what delivers that: measured 2026-09-21, before that rule, the gate passed while that job was still unregistered, the release went out unmarked, and no phone could be offered it -- so when the mobile job runs there is no published release to stamp. The desktop's publish step is the first moment a release exists AND its iOS verdict is known, so that is where the marker is written. A commit with no mobile run has no `release` job to read, so no marker, which is the intended outcome.

**The two readers are kept in agreement by the parity fixture** (`core/fixtures/feed.json`'s `iosCases`, asserted by `core/test/feed.test.js` and `mobile/ClawTests/UpdateFeedParityTests.swift`): a release without the marker is filtered out by the iOS reader, one with it is offered, and the desktop reader is proven to still read every release.

Three other things can block a publish, and none of them is this gate:

- The **artifact gate** (`desktop/scripts/check-release-artifacts.js`) refuses a release whose platform is present but incomplete, meaning a missing installer or missing update metadata, when every build leg succeeded.
- The **asset completeness check** in `release.yml`'s release job refuses to PUBLISH a release whose payload is incomplete. The release is created as a draft, every file the build produced is attached and then compared against what the release actually carries, and the draft is published only once the two agree. A run that cannot complete the set fails and withdraws the draft, so a release that is live is always one whose payload is whole. This is the half the artifact gate cannot see, because that gate reads the directory the build runners produced rather than the release itself: a flaky upload passes it, publishes, and leaves a release whose downloads can never finish. The payload is covered by the same rule as a red platform, in the same words: nothing ships while any part of it is missing.
- The **version job** stands a build down for a commit covered by its own tag build, so no publish is expected at all.

## How long a release takes, and the budget it is held to

**The fast path is a push to `main`, and its budget is 9 minutes to a published desktop release and 13 to a phone upload, on a healthy network.** Measured 2026-09-17, before the speed pass: the desktop released in 9 m 36 s, the phone in 13 m 19 s. The budget is a claim about our own work rather than a promise Apple keeps, because most of what is left is not ours.

| A push to `main`, measured 2026-09-17 | Desktop | Phone |
|---|---|---|
| end to end | 9 m 36 s | 13 m 19 s |
| this platform's own build legs | macOS 8 m 26 s, Windows 2 m 30 s, Linux 51 s | iOS 26 5 m 56 s, iOS 27 5 m 12 s |
| the gate | 5 m 58 s, in parallel | 8 m 35 s, in parallel |
| publish job | 50 s | 4 m 21 s |

**Both pipelines are paced by one job, and it is the macOS desktop leg.** The phone pipeline sits on its gate for 8 m 35 s while its own legs finish in under 6 minutes. Inside that leg's 7 m 40 s `Build` step, **6 m 47 s is four Apple notarization round trips taken one after another** (app arm64 2 m 32 s, app x64 2 m 28 s, dmg arm64 52 s, dmg x64 55 s); packaging, signing and dmg-building together are about 53 s. On the phone side the largest single cost was the simulator: 3 m 15 s of a 3 m 57 s test step was booting it and installing the bundles, against about 30 s of suite.

**That is the honest reason the end-to-end numbers cannot go much lower from inside this directory:**

- **The four notarizations are serial inside one electron-builder invocation.** Overlapping them would take the macOS leg to roughly 3 m 30 s, about four minutes off the shared critical path, and it is `electron-builder.yml` and `desktop/scripts/notarize.js` that would have to change, not a workflow.
- **Both iOS legs are the point of the matrix**, and a leg cannot verify a runtime it never booted.
- **The payload has to cross a runner boundary.** The build legs upload ~600 MB of installers as artifacts and the publish job downloads them to check the set. On 2026-09-17 the upload path was degraded to about 1 MB/s against 24 MB/s earlier that day, and that, rather than the job's own work, is what a slow publish job on such a day is.

**What the 2026-09-17 speed pass changed**, none of it by weakening a gate:

- Electron's distribution and electron-builder's tool bundles are cached per OS and lockfile (and the artifact upload stores rather than recompresses installers that are already compressed).
- Each Xcode bundle's version is read from `Contents/version.plist` instead of spawning `xcodebuild -version` once per bundle, which cost 28 s of an iOS 26 leg and 18 s of the phone publish job. The chosen bundle is still asked for its version, so the toolchain is proved to work, and the Xcode 16 floor is unchanged.
**Tried and rejected the same day**, so it is not attempted again: starting the simulator's first boot underneath the compile so it is not paid afterwards. The boot is CPU-bound rather than idle, so the compile absorbs all of it and more. On run `35275131733` the `Build for the simulator` step went from 31 s to 3 m 55 s on the iOS 27 leg and from 58 s to over 4 m 41 s on the iOS 26 leg, against a boot worth about two to three minutes inside the test step, so the leg ends up no shorter. Overlapping it needs a runner with cores to spare, which is a cost decision rather than a workflow one.

**Deliberately left slow**, so nobody removes one of these for a number: the simulator's first boot, which is paid serially because hiding it behind the compile costs more than it saves; the two iOS legs; the whole matrix on a publishing run (the artifact gate refuses a release that is missing a platform); and the draft → attach → verify → publish sequence, whose completeness check is the only thing standing between a flaky upload and a release whose downloads never finish.

## What this rule does not cover

Named so it is not mistaken for coverage.

- **A commit that only changes one client's tree still publishes for both.** Both pipelines run for every commit that ships, so a `desktop/`-only change is built, tested and uploaded on the phone before the desktop releases it. The gate keys on the commit being published, so an earlier unlucky commit whose `core/` change broke the phone does not block a later one: the release that accompanies the breaking change is blocked, which is the case the rule was written from.
- **A manual `workflow_dispatch` of one pipeline** is a dev build of that platform on demand, and it is held to the whole matrix like any other: it refuses when the other pipeline has no run for that commit rather than publishing, so dispatching one pipeline alone is no longer a way around the gate. Dispatching a ref that ships nothing refuses too, by the rule above.
- **A rolled-back or re-run publish** is not re-gated beyond the run it belongs to. A `gh run rerun` of a publish job re-reads the other pipeline's verdict as it stands at that moment.

## The files

| File | Owns |
|---|---|
| `platforms-gate.yml` | What "the other platform is green" means, and the refusal messages. Called by both pipelines. |
| `release.yml` | The desktop build matrix, the artifact gate, the asset completeness check, and the desktop release. |
| `mobile-pipeline.yml` | The iOS test matrix, the archive, and the TestFlight upload. |
| this file | The rule, the rationale for its two directions, and where to look. |

## The 2026-09-18 measurement: what the caches buy, and what they do not

Measured across two runs of the SAME commit (PR runs `35424068878` then `35424385502`), so the only difference between them is the caches. Comparing the baseline commit instead would be misleading: its legs ran 307 s and 186 s against 384 s and 377 s here, which is runner variance, not the change.

| iOS leg step | cold | warm (cache hit) |
|---|---|---|
| Install xcodegen | 2 s / 4 s | 0 s, skipped |
| Generate the Xcode project | 0 s | 0 s, skipped |
| Build for the simulator | 34 s (iOS 27), 50 s (iOS 26) | 17 s (iOS 27) |
| Test on the resolved simulator | 320 s (iOS 27), 285 s (iOS 26) | the same work, uncacheable |
| job total | 384 s (iOS 27), 377 s (iOS 26) | see the run |

What was restored: `deriveddata-26` and `deriveddata-27` (77 to 78 MiB), `xcodeproj` (12 KiB) and `swiftpm` (1.7 KiB). The restore is verifiable from the cache list alone, because each key's `lastAccessedAt` is seconds after its `createdAt`. The 1.7 KiB Swift package cache is also the evidence that this project declares no Swift packages, which is why that layer carries nothing yet.

**Said plainly: the cache removes the compile, and the simulator is what dominates an iOS leg.** Booting the simulator and installing the bundles is the largest single cost and no cache can skip it, so the saving is tens of seconds on a leg that takes minutes. The full matrix is affordable because it is parallel and its fixed costs are off the critical path, not because caching makes an iOS leg fast. Claiming more than that would not survive the numbers above.
