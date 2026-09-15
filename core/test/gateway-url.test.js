// The token handoff, as core owns it.
//
// The contract the Control UI relies on: the token lands on the fragment (never
// the query, so it stays out of request logs and Referer), an existing fragment
// is preserved, and a URL that will not parse is handed back untouched rather
// than thrown.

import test from 'node:test';
import assert from 'node:assert';

import { withTokenHandoff } from '../gateway-url.js';

test('a token is placed on the fragment, not the query', () => {
  const out = withTokenHandoff('https://h.ts.net/', 'abc123');
  const url = new URL(out);
  assert.equal(url.search, '', 'token must not reach the query string');
  const frag = new URLSearchParams(url.hash.slice(1));
  assert.equal(frag.get('token'), 'abc123');
});

test('no token leaves the url exactly as it was', () => {
  assert.equal(withTokenHandoff('https://h.ts.net/', ''), 'https://h.ts.net/');
  assert.equal(withTokenHandoff('https://h.ts.net/', undefined), 'https://h.ts.net/');
  assert.equal(withTokenHandoff('https://h.ts.net/', null), 'https://h.ts.net/');
});

test('an existing fragment is preserved and only token is set', () => {
  const out = withTokenHandoff('https://h.ts.net/#view=chat', 'tok');
  const frag = new URLSearchParams(new URL(out).hash.slice(1));
  assert.equal(frag.get('view'), 'chat');
  assert.equal(frag.get('token'), 'tok');
});

test('reapplying replaces the token rather than appending a second one', () => {
  const once = withTokenHandoff('https://h.ts.net/', 'old');
  const twice = withTokenHandoff(once, 'new');
  const frag = new URLSearchParams(new URL(twice).hash.slice(1));
  assert.equal(frag.get('token'), 'new');
  assert.equal(frag.getAll('token').length, 1, 'only one token key');
});

test('an unparseable url is handed back untouched', () => {
  assert.equal(withTokenHandoff('not a url', 'tok'), 'not a url');
});
