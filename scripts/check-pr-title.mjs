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

function main(argv) {
  const title = argv[0] || '';
  const result = checkTitle(title);
  if (result.ok) {
    console.log('ok: the pull request title reads as a sentence');
    process.exit(0);
  }
  console.error(`::error::${result.reason}`);
  console.error(`  title: ${title}`);
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
