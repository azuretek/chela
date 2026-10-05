#!/usr/bin/env node
// The pull request title is the changelog line (issue #167).
//
// release-please builds each release's changelog from commit subjects, and this
// repo squash merges, so a pull request title becomes the subject the changelog
// is grouped from. A one-word label ("fix: bug") reads as a label, not a change
// a person can understand a release from, so a title has to read as a sentence:
//
//     type(scope): a sentence
//
// This is the check CI runs on every pull request. It is mechanical on purpose;
// a title a model has to judge is a title the gate cannot enforce.
//
//   node scripts/check-pr-title.mjs "fix(desktop): the tray icon follows the theme"

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// The conventional types we write, plus revert. Kept in step with
// release-please-config.json's changelog-sections.
const TYPES = [
  'feat', 'fix', 'perf', 'refactor', 'docs', 'chore', 'test', 'build', 'ci', 'revert',
];

// release-please's own release pull request is allowed its short form: it names
// the version, which is the whole point of that title.
const RELEASE_TITLE = /^release \d+\.\d+\.\d+$/;

/**
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function checkTitle(title) {
  const raw = String(title || '').trim();
  if (!raw) return { ok: false, reason: 'the title is empty' };

  const match = /^([a-z]+)(?:\(([^()]+)\))?!?: (.+)$/.exec(raw);
  if (!match) {
    return {
      ok: false,
      reason: 'the title must be `type(scope): a sentence`, for example '
        + '`fix(desktop): the tray icon follows the theme`',
    };
  }

  const [, type, , summary] = match;
  if (!TYPES.includes(type)) {
    return { ok: false, reason: `${type} is not one of our conventional types (${TYPES.join(', ')})` };
  }

  const text = summary.replace(/\s*\(#\d+\)\s*$/, '').trim();
  if (!RELEASE_TITLE.test(text)) {
    const words = text.split(/\s+/).filter(Boolean);
    if (!/^[A-Za-z]/.test(words[0] || '') || words.length < 3) {
      return {
        ok: false,
        reason: 'the part after the colon must read as a sentence for a reader, '
          + 'not a one-word label',
      };
    }
  }

  return { ok: true };
}

/**
 * The `type: <type>` label for this title, or null when the check refuses it.
 *
 * ★ The kind of change is read from the SAME parse checkTitle accepts, so no
 * second place decides it. A title the check refuses, a one-word label or no
 * type at all, gets no label rather than one derived from an unparsed title.
 */
export function labelForTitle(title) {
  if (!checkTitle(title).ok) return null;
  const match = /^([a-z]+)(?:\(([^()]+)\))?!?: /.exec(String(title || '').trim());
  return match && TYPES.includes(match[1]) ? `type: ${match[1]}` : null;
}

function main(argv) {
  const title = argv[0] || '';
  const result = checkTitle(title);
  if (!result.ok) {
    console.error(`::error::${result.reason}`);
    console.error(`  title: ${title}`);
    process.exit(1);
  }
  console.log('ok: the pull request title reads as a sentence');

  // ★ Apply the kind of change HERE, where the title is parsed (issue #170), so
  // there is one place that decides it. A refused title never reaches this line,
  // so it gets no label. Outside CI there is no pull request to label, and the
  // label is only reported.
  const label = labelForTitle(title);
  if (!label) return;
  const repo = process.env.GITHUB_REPOSITORY;
  const pr = process.env.PR_NUMBER;
  if (!repo || !pr || !(process.env.GH_TOKEN || process.env.GITHUB_TOKEN)) {
    console.log('ok: no pull request to label here; the kind of change is ' + label);
    return;
  }
  applyLabel(repo, pr, label);
}

// Apply the type label to the pull request, creating the label first so a new
// type (or a fresh repository) does not fail the check. gh is on the runner.
function applyLabel(repo, pr, label) {
  try {
    execFileSync('gh', [
      'label', 'create', label, '--repo', repo, '--force',
      '--color', 'ededed', '--description', 'The kind of change, read from the pull request title',
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
  } catch (error) {
    console.error(`::warning::could not ensure the ${label} label exists: ${lastLine(error)}`);
  }
  try {
    execFileSync('gh', ['pr', 'edit', String(pr), '--repo', repo, '--add-label', label], { stdio: ['ignore', 'ignore', 'pipe'] });
    console.log(`applied ${label} to ${repo}#${pr}`);
  } catch (error) {
    console.error(`::error::could not apply the ${label} label to ${repo}#${pr}: ${lastLine(error)}`);
    process.exit(1);
  }
}

function lastLine(error) {
  const said = error && error.stderr ? String(error.stderr) : String((error && error.message) || error);
  const lines = said.trim().split('\n');
  return lines[lines.length - 1];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
