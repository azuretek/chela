import test from 'node:test';
import assert from 'node:assert/strict';
import { checkTitle } from '../../scripts/check-pr-title.mjs';

test('a sentence title is accepted', () => {
  assert.equal(checkTitle('fix(desktop): the tray icon follows the theme').ok, true);
  assert.equal(checkTitle('feat: a release lands from a reviewed pull request').ok, true);
});

test('a label-shaped title is refused', () => {
  assert.equal(checkTitle('fix: bug').ok, false);
  assert.equal(checkTitle('desktop icons').ok, false);
  assert.equal(checkTitle('Fix the thing').ok, false);
  assert.equal(checkTitle('wip: it').ok, false);
});

test('release-please\'s own release title is allowed', () => {
  assert.equal(checkTitle('chore(main): release 0.0.1').ok, true);
});

test('a trailing pull request number does not make a label a sentence', () => {
  assert.equal(checkTitle('fix: bug (#12)').ok, false);
});
