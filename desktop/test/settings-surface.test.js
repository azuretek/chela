// The settings surface is shared by two clients, and this is what holds that
// arrangement up.
//
// core/ui/settings.html and its script are ONE implementation, rendered by the
// desktop and by the iOS app alike. What differs between them is which tabs and
// which settings apply, and that is data in core/spec/settings.json rather than a
// branch in the page. Three things can quietly break that, and none of them is
// visible from either client at runtime:
//
//   1. the page and the spec disagreeing, so a tab or a setting is missing on one
//      client, or marked for a client that does not exist;
//   2. the page growing a branch on which client it is running in, which is how a
//      shared surface becomes two surfaces that share a file;
//   3. a command declared in the spec that the desktop's host does not implement,
//      which is a button that does nothing, or one implemented here and declared
//      nowhere, which is a host carrying work its client's surface never asked for.
//
// A move is the fourth, and it is the one that has actually happened here: the
// pages are no longer in desktop/src/ui, so what the tests below assert most
// carefully is that the markup and the spec still name the same things.
//
// Run with: npm test

import test from 'node:test';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.join(HERE, '..');
const REPO = path.join(DESKTOP, '..');

const read = (...parts) => fs.readFileSync(path.join(...parts), 'utf8');

const spec = JSON.parse(read(REPO, 'core', 'spec', 'settings.json'));
const html = read(REPO, 'core', 'ui', 'settings.html');
const page = read(REPO, 'core', 'ui', 'settings.js');
const preload = read(DESKTOP, 'src', 'preload.cjs');

const ids = (list) => list.map((e) => e.id);
const clientNames = Object.keys(spec.clients);

test('the spec describes a surface at all', () => {
  // A spec that lost a section would turn every assertion below into one that
  // cannot fail, which is the failure mode a test file like this has.
  assert.ok(spec.tabs.length >= 4, `only ${spec.tabs.length} tabs`);
  assert.ok(spec.settings.length >= 6, `only ${spec.settings.length} settings`);
  assert.ok(spec.commands.length >= 10, `only ${spec.commands.length} commands`);
  assert.ok(spec.events.length >= 2, `only ${spec.events.length} events`);
  assert.ok(spec.queued.length >= 1, 'the queued list is empty');
  assert.ok(clientNames.length >= 2, `only ${clientNames.length} clients`);
});

test('every entry names a client that exists', () => {
  for (const group of ['tabs', 'settings', 'commands', 'events', 'queued']) {
    for (const entry of spec[group]) {
      assert.ok(entry.clients.length > 0, `${group}/${entry.id} names no client`);
      for (const client of entry.clients) {
        assert.ok(clientNames.includes(client), `${group}/${entry.id} names an unknown client: ${client}`);
      }
      for (const client of Object.keys(entry.absent || {})) {
        assert.ok(clientNames.includes(client), `${group}/${entry.id} has a reason for an unknown client: ${client}`);
        // The reason is for a client that does NOT have it. A reason filed against
        // a client that has the thing is worse than no reason: it reads as a
        // decision while describing something else.
        assert.ok(!entry.clients.includes(client), `${group}/${entry.id} is absent on ${client} and also granted to it`);
        assert.equal(typeof entry.absent[client], 'string', `${group}/${entry.id} absent reason should be prose`);
      }
    }
  }
});

test('every absence is a decision rather than an oversight', () => {
  // The whole point of the split: a setting the phone does not have must say
  // WHY, so that absent and not-yet-built can be told apart. The queued list is
  // the other half of that sentence, so the two are checked for overlap too.
  const queued = new Set(ids(spec.queued));
  for (const group of ['tabs', 'settings']) {
    for (const entry of spec[group]) {
      if (entry.clients.length === clientNames.length) continue;
      const missing = clientNames.filter((c) => !entry.clients.includes(c));
      for (const client of missing) {
        assert.ok(entry.absent && entry.absent[client],
          `${group}/${entry.id} is absent on ${client} with no reason: say why it has no meaning there`);
      }
      assert.ok(!queued.has(entry.id), `${group}/${entry.id} is both absent and queued, which is two different answers`);
    }
  }
  for (const entry of spec.queued) {
    for (const field of ['what', 'hook', 'why']) {
      assert.ok(entry[field] && entry[field].length > 20, `queued/${entry.id} has no ${field}`);
    }
  }
});

test('no two entries share an id', () => {
  for (const group of ['tabs', 'settings', 'commands', 'events', 'queued']) {
    const list = ids(spec[group]);
    assert.equal(new Set(list).size, list.length, `${group} has a duplicate id`);
  }
});

test('every setting belongs to a tab that exists', () => {
  for (const setting of spec.settings) {
    assert.ok(ids(spec.tabs).includes(setting.tab),
      `setting ${setting.id} is filed under ${setting.tab}, which is not a tab`);
  }
  for (const tab of spec.firstRunTabs) {
    assert.ok(ids(spec.tabs).includes(tab), `firstRunTabs names ${tab}, which is not a tab`);
  }
});

test('every tab in the spec is a tab in the page, and the other way round', () => {
  // Both directions, because each catches a different mistake: a tab added to the
  // spec and not to the page is a tab that never appears, and a tab in the page
  // and not in the spec is a tab no client can be said to have, on a page that
  // hides what the spec does not name.
  for (const tab of spec.tabs) {
    assert.ok(html.includes(`id="tab-${tab.id}"`), `no tab button for ${tab.id} in settings.html`);
    assert.ok(html.includes(`id="panel-${tab.id}"`), `no panel for ${tab.id} in settings.html`);
  }
  // Matched through the class rather than every `id="tab-*"`, which would also
  // catch the Problems tab's count badge and report it as a tab nobody declared.
  const inPage = [...html.matchAll(/class="tab"[^>]*id="tab-([\w-]+)"/g)].map((m) => m[1]);
  assert.ok(inPage.length >= 4, `only ${inPage.length} tab buttons found`);
  for (const id of inPage) {
    assert.ok(ids(spec.tabs).includes(id), `the page has a ${id} tab the spec does not list`);
  }
  for (const [, id] of html.matchAll(/id="panel-([\w-]+)"/g)) {
    assert.ok(ids(spec.tabs).includes(id), `the page has a ${id} panel the spec does not list`);
  }
});

test('every setting in the spec is marked in the page, and the other way round', () => {
  // A setting's marker may be in the markup or built by the script (the extra
  // headers are built, because a client without them must not even list the names
  // it holds), so both files are searched.
  const marked = (id) => html.includes(`data-setting="${id}"`)
    || page.includes(`setAttribute('data-setting', '${id}')`);

  for (const setting of spec.settings) {
    assert.ok(marked(setting.id), `${setting.id} is in the spec but nothing in the page is marked with it`);
  }

  const inPage = [
    ...[...html.matchAll(/data-setting="([\w-]+)"/g)].map((m) => m[1]),
    ...[...page.matchAll(/setAttribute\('data-setting', '([\w-]+)'\)/g)].map((m) => m[1]),
  ];
  assert.ok(inPage.length >= 6, `only ${inPage.length} marked settings found`);
  for (const id of inPage) {
    assert.ok(ids(spec.settings).includes(id), `the page marks a ${id} setting the spec does not list`);
  }
});

test('the page never asks which client it is running in', () => {
  // The invariant that keeps this one surface rather than two. The page filters by
  // the spec's lists, so it reads `state.client` and compares it against each
  // entry's own client list. What it must never do is compare it against a client
  // NAME, because that is a branch only one client takes, and the second one of
  // those is the moment the two clients need two pages again.
  assert.doesNotMatch(page, /'ios'/, 'settings.js names the iOS client: a shared page must not branch on which client it is');
  assert.doesNotMatch(page, /'desktop'/, 'settings.js names the desktop client: a shared page must not branch on which client it is');
  // And it reaches the app through the host, not through the desktop's own bridge,
  // which does not exist on the phone.
  assert.doesNotMatch(page, /window\.clawDesktop/,
    'settings.js uses the desktop bridge directly; the host is the only door on both clients');
  assert.match(page, /window\.clawSettings/, 'settings.js does not read the settings host');
});

test('the desktop implements every command its half of the spec declares', () => {
  const block = /contextBridge\.exposeInMainWorld\(.clawSettings., \{([\s\S]*?)\n  \}\);/.exec(preload);
  assert.ok(block, 'the clawSettings host was not found in preload.cjs');
  const [invokePart, onPart] = block[1].split(/on: \(event, fn\) => \{/);
  assert.ok(invokePart && onPart, 'preload.cjs no longer has both an invoke and an on');

  const declared = (part, group) => ids(spec[group]).length && spec[group]
    .filter((e) => e.clients.includes('desktop')).map((e) => e.id);

  // Exactly the table entries: ten spaces of indentation inside `const table`, so
  // that `invoke` and `on` themselves, which sit six spaces in, are not counted as
  // commands the host implements.
  const keys = (part) => [...part.matchAll(/^ {10}(\w+):\s+\(/gm)].map((m) => m[1]);
  const implemented = keys(invokePart);
  assert.ok(implemented.length >= 10, `only ${implemented.length} commands in the preload`);
  for (const command of declared(invokePart, 'commands')) {
    assert.ok(implemented.includes(command), `the spec gives desktop the ${command} command and preload.cjs does not implement it`);
  }
  for (const command of implemented) {
    assert.ok(ids(spec.commands).includes(command), `preload.cjs implements ${command}, which the spec does not declare`);
  }

  const events = keys(onPart);
  assert.ok(events.length >= 2, `only ${events.length} events in the preload`);
  for (const event of declared(onPart, 'events')) {
    assert.ok(events.includes(event), `the spec gives desktop the ${event} event and preload.cjs does not raise it`);
  }
  for (const event of events) {
    assert.ok(ids(spec.events).includes(event), `preload.cjs raises ${event}, which the spec does not declare`);
  }
});
