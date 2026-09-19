// The token handoff, as core owns it.
//
// The contract the Control UI relies on: the token lands on the fragment (never
// the query, so it stays out of request logs and Referer), an existing fragment
// is preserved, and a URL that will not parse is handed back untouched rather
// than thrown.

import test from 'node:test';
import assert from 'node:assert';

import { withTokenHandoff, withBootstrapHandoff } from '../gateway-url.js';

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

test('a bootstrap token is placed on the fragment under bootstrapToken, not token', () => {
  const out = withBootstrapHandoff('https://h.ts.net/', 'setup123');
  const url = new URL(out);
  assert.equal(url.search, '', 'bootstrap token must not reach the query string');
  const frag = new URLSearchParams(url.hash.slice(1));
  assert.equal(frag.get('bootstrapToken'), 'setup123');
  assert.equal(frag.get('token'), null, 'a setup code is not the shared connect token');
});

test('no bootstrap token leaves the url exactly as it was', () => {
  assert.equal(withBootstrapHandoff('https://h.ts.net/', ''), 'https://h.ts.net/');
  assert.equal(withBootstrapHandoff('https://h.ts.net/', undefined), 'https://h.ts.net/');
  assert.equal(withBootstrapHandoff('https://h.ts.net/', null), 'https://h.ts.net/');
});

test('an existing fragment is preserved and only bootstrapToken is set', () => {
  const out = withBootstrapHandoff('https://h.ts.net/#view=chat', 'boot');
  const frag = new URLSearchParams(new URL(out).hash.slice(1));
  assert.equal(frag.get('view'), 'chat');
  assert.equal(frag.get('bootstrapToken'), 'boot');
});

test('token and bootstrap handoffs coexist on one fragment without clobbering', () => {
  const withTok = withTokenHandoff('https://h.ts.net/', 'shared');
  const both = withBootstrapHandoff(withTok, 'setup');
  const frag = new URLSearchParams(new URL(both).hash.slice(1));
  assert.equal(frag.get('token'), 'shared');
  assert.equal(frag.get('bootstrapToken'), 'setup');
});

test('an unparseable url is handed back untouched by the bootstrap handoff', () => {
  assert.equal(withBootstrapHandoff('not a url', 'boot'), 'not a url');
});
