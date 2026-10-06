# Contributing

Chela is one project with a shared core and one interface per form
factor, so a change usually belongs in one place and is consumed everywhere else.
Where things belong is [DESIGN.md](DESIGN.md); what to run before you push is
[TESTING.md](TESTING.md).

## How a change lands

**Every change lands as a pull request.** Push the branch, open the pull request,
let CI run, and merge when it is green. The legs compile and test and ship
nothing, so they need no Apple credential. A change that touches only markdown
runs no legs at all, because both workflows filter on paths a documentation file
does not match, and there the local suites are the gate.

**Tests passing is the whole gate, because the maintainer is the one merging.**
Nobody waits to have their own change reviewed back to them, and nobody merges
past a red leg: the flip side of merging without a separate review is that the
tests are not negotiable.

A pull request body carries three sections, which is what the reason for them
does not depend on: the problem, the change, and the test with its output.
`.github/PULL_REQUEST_TEMPLATE.md` is the shape, and a commit body that
carries the same three things is a good commit body.

**The pull request title is the changelog line.** release-please groups each
release from commit subjects and we squash merge, so a title becomes the subject
the changelog is built from and it has to read as a sentence, not a label:
`type(scope): a sentence`, where `type` is one of `feat`, `fix`, `perf`,
`refactor`, `docs`, `chore`, `test`, `build`, `ci` or `revert`. CI refuses a
label-shaped title (`fix: bug`) on every pull request. See
[RELEASE.md](RELEASE.md#release-notes-and-the-version-bump).

## What "the test" means

- **A command and its output, pasted.** Not "tests pass".
- **The case that fails without the patch**, named, so the test is shown to bite.
  A test that would pass either way is not evidence.
- **What was not run**, said plainly. A gap named is a gap; a gap left silent
  reads as coverage.
- **The measurement that settled a choice**, when there was a choice. The number
  is what makes the decision checkable later.
