# Contributing

Claw Control UI is one project with a shared core and one interface per form
factor, so a change usually belongs in one place and is consumed everywhere else.
Where things belong is [layout.md](layout.md); what to run before you push is
[testing.md](testing.md).

## How a change lands

**Small changes go straight to main.** Run the suites, then commit with a
conventional message and push. The commit log is the review for a change that is
reversible and inside one tree.

**A pull request is for a change that needs something a push cannot give it**,
which in practice is one of two things: verification only CI can produce, such as
anything Swift, because the iOS build needs a macOS runner; or review before it
lands. The pull-request legs compile and test and ship nothing, so they need no
Apple credential.

Both paths write the same three sections, because the reason for them does not
depend on the path: the problem, the change, and the test with its output.
`.github/pull_request_template.md` is the shape, and a commit body that
carries the same three things is a good commit body.

## What "the test" means

- **A command and its output, pasted.** Not "tests pass".
- **The case that fails without the patch**, named, so the test is shown to bite.
  A test that would pass either way is not evidence.
- **What was not run**, said plainly. A gap named is a gap; a gap left silent
  reads as coverage.
- **The measurement that settled a choice**, when there was a choice. The number
  is what makes the decision checkable later.

## House rules for anything public

- The author is Abi Renhart. No co-author trailers and no "generated with" lines,
  anywhere: a pull request, an issue, a commit, a review comment.
- **No em dashes**, in any of it.
- Names and identifiers come from their one owner in `core/spec/`, and the
  inventory in `core/test/specs.test.js` is what fails when a spec is neither
  classified nor shipped.
