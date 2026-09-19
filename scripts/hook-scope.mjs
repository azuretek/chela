#!/usr/bin/env node
// Which local hook work a change actually needs.
//
// The two .githooks run GUI-bound work: the page measurements (pre-commit) and
// the app boot smoke (pre-push) both launch Electron. On a small host that is
// minutes per commit and per push, and it was paid for changes that cannot move
// the app at all: a mobile-only commit, a docs edit, a workflow change, or a
// change to the hooks themselves renders exactly the pages that were rendered
// before. Abi, 2026-09-18: "what is being run that's taking so long? can we
// improve the speed somehow?"
//
// CI cannot run either check (GitHub's macOS runners have no GUI session), so
// scoping them here is a local decision and not a hole: every headless check CI
// runs is unchanged, and the iOS legs still run there.
//
// A pure function plus a stdin CLI, so the decision is unit-testable rather than
// buried in shell. scripts/... is what the hooks call; a rule in shell is what
// nothing can test.

const TRIGGERS = [
  /^desktop\//, // the Electron app, its pages, its forms and its tests
  /^core\//, // the shared core the app compiles in, and core/ui the pages render
  /^package\.json$/, // a root manifest can change the dependency graph
  /^pnpm-lock\.yaml$/,
  /^pnpm-workspace\.yaml$/,
  /^scripts\//, // a root script the hooks, the build or the mobile lane call
  /^\.githooks\//, // a hook change should be exercised by the hook it changed
];

/** Does this list of changed paths need the GUI-bound local hook work? */
export function needsDesktopWork(paths) {
  return paths.some((p) => TRIGGERS.some((re) => re.test(p)));
}

/** 'run' or 'skip' for a list of paths, with the safe answer for an empty list. */
export function decisionFor(paths) {
  // No paths is not evidence of a narrow change (nothing staged, or a range that
  // could not be read), so the safe answer is to run the work rather than skip it.
  if (paths.length === 0) return 'run';
  return needsDesktopWork(paths) ? 'run' : 'skip';
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  let input = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) input += chunk;
  const paths = input.split('\n').map((s) => s.trim()).filter(Boolean);
  process.stdout.write(decisionFor(paths) + '\n');
}
