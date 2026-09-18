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
// A fifth is the surface's own copy and layout, which exist only on screen: a
// credential line that composes the right words into an element nobody can see, a
// narrow-width rule that never fires, and a card that was meant to move but is
// still duplicated per tab all read as correct from a diff of the source. The
// last four tests hold the wording, the two halves of the row's structure and the
// one-card rule. The MEASUREMENTS, meaning the boxes and the screenshots, are in
// scripts/test-settings-surface.js, which runs the real app, because a stylesheet
// assertion cannot tell a rule that applies from one that is overridden.
//
// Two more joined them for the spacing and the header column, and they are the
// pair this file's own lesson asks for: the SHAPE of the rules that own a gap and
// a leading edge is asserted here ("the gap between two blocks belongs to the
// element that holds them", "every text line in the header declares its own inset"),
// and what those rules produce on screen is measured, at two widths and in both
// appearances, by scripts/test-settings-layout.js. Spacing is the case a static
// assertion cannot finish on its own: a gap vanished because a selector stopped
// MATCHING, which no reading of the stylesheet can tell you.
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

/**
 * The page's source with its comments removed.
 *
 * A rule about what the page SAYS is a rule about the code that runs, and this
 * file has to be able to quote what it replaced: the credential line's old
 * sentence is worth keeping in the comment that explains why it went, and a
 * raw search of the file would read that quotation as the sentence still being
 * there. Strings are kept, so a line composed into an element is still found.
 * Deliberately a small scanner rather than a regex: `//` inside a URL string is
 * not a comment, and treating it as one would silently drop code from the
 * search, which is the one way a check like this can pass while missing things.
 */
function codeOnly(src) {
  let out = '';
  let quote = null;
  for (let i = 0; i < src.length;) {
    const c = src[i];
    const next = src[i + 1];
    if (quote) {
      out += c;
      if (c === '\\') { out += next ?? ''; i += 2; continue; }
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === '/' && next === '/') { while (i < src.length && src[i] !== '\n') i += 1; continue; }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    out += c;
    i += 1;
  }
  return out;
}

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

test('the credentials line reports the token and the device, and promises nothing', () => {
  // What was there said "No saved credentials, you will be asked to sign in", and
  // both halves of it were claims rather than observations: a gateway that needs
  // no credential never asks, so the sentence promised a sign-in that would not
  // happen, and "no saved credentials" described this app's storage rather than
  // this connection. What replaced it is the state, so the sentence must be gone
  // and both facts must still be composed from the state that already exists.
  assert.doesNotMatch(codeOnly(page), /No saved credentials/i,
    'the credentials line is back to saying there are no saved credentials');
  assert.doesNotMatch(codeOnly(page), /asked to sign in/i,
    'the credentials line is back to promising a sign-in');

  for (const fact of ['Token saved', 'No token saved', 'Device approved', 'Device needs approval']) {
    assert.ok(page.includes(`'${fact}'`), `the credentials line never says ${fact}`);
  }

  // Both facts come from state the clients already send: the credential summary,
  // and the connection phase the row's own "Needs approval" badge is drawn from.
  assert.match(page, /conn\.phase === 'pending'/,
    'the device half no longer reads the phase the badge uses');
  assert.match(page, /conn\.phase === 'connected'/, 'the device half never reads the approved phase');
  // And it is ONE wording: the line is the same on every client, so it must not
  // have grown a branch on which client is running it, which the test above
  // already forbids by name.
  assert.match(page, /facts\.join\(' · '\)/, 'the credential line is no longer composed in one place');
});

test('a gateway row is content, state and actions, as three groups', () => {
  // The grouping is what a narrow window needs: the buttons can be moved onto a
  // line of their own only if they are a thing that can be moved, and the state's
  // pill can be centred without being stretched only if the centred thing is the
  // group around it. Both are invisible at full width, which is exactly why this
  // is asserted here rather than left to the screenshots.
  //
  // The row is upstream's `settings-row` now, and that is a structural change
  // rather than a rename: the state and the actions moved INTO the row's control
  // column, which is the slot upstream gives a row for whatever trails its text.
  // So the assertion below checks that third level too, because a row whose two
  // groups are still direct children would stack by wrapping rather than by
  // stacking its control, and the narrow rule depends on the difference.
  const row = /const row = el\('div', \{ className: 'settings-row' \}, \[([\s\S]*?)\n    \]\);/.exec(page);
  assert.ok(row, 'the gateway row is no longer built as one literal, so this test cannot see it');
  const body = row[1];

  const textAt = body.indexOf('settings-row__text');
  const controlAt = body.indexOf('settings-row__control');
  const statusAt = body.indexOf('row__status');
  const actionsAt = body.indexOf('row__actions');
  const badgeAt = body.indexOf('badge badge--');
  const firstButtonAt = body.indexOf("el('button'");

  assert.ok(textAt >= 0, 'the row no longer opens with the upstream text column');
  assert.ok(controlAt > textAt, 'the row no longer has a control column after its text');
  assert.ok(statusAt > controlAt, 'the connection state is no longer inside the control column');
  assert.ok(actionsAt > statusAt, 'the row no longer groups its buttons after the state');
  assert.ok(badgeAt > statusAt && badgeAt < actionsAt, 'the badge is no longer inside the state group');
  assert.ok(firstButtonAt > actionsAt, 'a button is still a loose child of the row');
  assert.equal([...body.matchAll(/el\('button'/g)].length, 3, 'the row is not three buttons any more');
});

test('a gateway is created with the fields it is edited with, from ONE field set', () => {
  // The reported fault, and this is its shape: the add form took a name and an
  // address and the editor took a name, an address, a token, a password and
  // headers, so a gateway created on the form was half-configured from the moment
  // it existed, and finishing it meant finding its row again and pressing Edit.
  // Two shapes for one object is how that happened, so the fix is one builder
  // that both flows render, and that is what this holds.
  const code = codeOnly(page);
  assert.strictEqual((code.match(/function gatewayFields\(/g) || []).length, 1,
    'there is not exactly one gateway field set in the shared page');

  const editor = /function gatewayEditor\(gw\) \{[\s\S]*?\n\}/.exec(code);
  assert.ok(editor, 'the editor is no longer built by a function this test can read');
  assert.match(editor[0], /gatewayFields\(gw, \{ mode: 'stored'/,
    'the editor builds its own fields, so the two flows can come to offer different things');

  const addForm = /function renderAddForm\(\) \{[\s\S]*?\n\}/.exec(code);
  assert.ok(addForm, 'the add form is no longer built by a function this test can read');
  assert.match(addForm[0], /gatewayFields\(\{\}, \{\s*mode: 'new'/,
    'the add form builds its own fields rather than rendering the shared set');

  // The fields the editor has, present on the form that creates a gateway. Named
  // one at a time because the equality this is really about cannot be read off
  // the source: the harness that measures the rendered page is
  // scripts/capture-gateway-form.js, and this is the half a diff can hold.
  for (const id of ['new-url', 'new-token', 'new-password', 'new-header-name', 'new-header-value']) {
    assert.ok(addForm[0].includes(id), `the add form no longer carries ${id}`);
  }

  // And it SAVES them, in the same pass, through the command the editor uses.
  // A form that offers a token and drops it on the way to the store is the same
  // fault with an extra step.
  const save = /async function saveNewGateway\(fields, out\) \{[\s\S]*?\n\}/.exec(code);
  assert.ok(save, 'the one-pass save is gone');
  assert.match(save[0], /call\('setCredentials', id, creds\)/,
    'the add form does not store the credentials typed into it');
  assert.match(save[0], /res\.added\.id/,
    'the credential is not stored against the gateway that was just created');
  assert.match(save[0], /call\('addHeader', id,/,
    'the add form does not store the extra header typed into it');

  // The sentence that sent the reader away to finish the job, which is the
  // behaviour this replaced.
  assert.doesNotMatch(code, /Use Edit to save its token/,
    'the form still tells the reader to press Edit to finish a new gateway');

  // And the wording the reader has to act on. "Add" named neither what was added
  // nor where the values went, and the label "Add a gateway" sat on the name
  // INPUT, so the section had no name and that field had two.
  assert.match(addForm[0], /textContent: 'Add gateway'/, 'the primary button does not name what it adds');
  assert.match(addForm[0], /textContent: 'Add a gateway'/,
    'the form has no heading of its own, so its first field is carrying the section title');
});

test('the narrow-width rule stacks the row inside the width query only', () => {
  const css = read(REPO, 'core', 'ui', 'ui.css');
  const query = '@media (max-width: 601px)';
  const at = css.indexOf(query);
  assert.ok(at > 0, 'the narrow-width media query is gone');
  const narrow = new RegExp(`@media \\(max-width: 601px\\) \\{([\\s\\S]*?)\\n\\}`).exec(css);
  assert.ok(narrow, 'the narrow-width media query has no readable block');
  const block = narrow[1];

  // The control column is what stacks, and that is the mechanism the row shape
  // moved to: the state and the buttons are two groups inside one column, so
  // making that column vertical is what puts them on lines of their own. A rule
  // that gave each group `flex-basis: 100%` inside a ROW would look like it did
  // the same thing and would leave the two sharing a line at the widths this is
  // for.
  assert.match(block, /\.settings-row__control[^{]*\{[^}]*flex-direction: column/,
    'the control column no longer stacks, so the state and the buttons share a line');
  assert.match(block, /\.settings-row__text[^{]*\{[^}]*flex-basis: 100%/,
    'the text column no longer takes a line of its own in the narrow layout');
  assert.match(block, /\.row__status[^{]*\{[^}]*justify-content: center/,
    'the state is no longer centred in the narrow layout');
  assert.match(block, /\.row__actions > button[^{]*\{[^}]*flex: none/,
    'the buttons now stretch to fill the wrapped line');

  // And the wide row is untouched by any of it: every one of those rules is
  // inside the query, and the row's own base declaration is outside it.
  const base = css.indexOf('.row__status,');
  assert.ok(base >= 0 && base < at, 'the groups\' base rule moved inside the width query');
  const baseRow = /\.settings-row \{([^}]*)\}/.exec(css.slice(css.indexOf('.settings-row {'), at));
  assert.match(baseRow ? baseRow[1] : '', /justify-content: space-between/,
    'the wide row rule is not upstream\'s own one-line row any more');
  assert.ok(!/flex-wrap/.test(baseRow ? baseRow[1] : ''), 'the row wraps at full width now');
});

test('the gap between two blocks belongs to the element that holds them', () => {
  // Two settings groups ran into each other on screen with no gap at all, and the
  // reason was the SHAPE of the rule rather than its value: the gap was declared
  // with `.settings-group + .settings-group`, which matches only two groups that
  // are SIBLINGS. Most of this page's groups are not: the script fills a host
  // (`#gateways`, `#certs`, `#notice-history`) with one group per entry, and the
  // two cards at the foot are groups on a PANEL and on the modal body, so at both
  // of the edges a reader sees, a wrapper sat between the two groups and the rule
  // never applied. Upstream's own arrangement is the other one: its
  // `.settings-section` is a flex column with `gap: var(--space-3)`, so the gap is
  // owned by the element HOLDING the groups.
  //
  // Which is what this asserts, on the stylesheet, because the fault is invisible
  // in every way except a rendered box (see scripts/test-settings-layout.js for
  // that half): adjacency may not be how a group is spaced.
  //
  // Read with its comments REMOVED, and that is not tidiness: the comment beside
  // the rule quotes the selector this asserts is gone, which is how the replaced
  // shape stays findable, so a raw read of the file tests the prose rather than
  // the code. Measured on the first run of this test: it failed against the fixed
  // stylesheet because of the comment explaining the fix.
  const css = read(REPO, 'core', 'ui', 'ui.css').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(css, /\.settings-group\s*\+\s*\.settings-group/,
    'settings groups are spaced by sibling adjacency again: a host element between two groups silently removes the gap');
  assert.match(css, /\.settings-group:not\(:first-child\)\s*\{[^}]*margin-top: var\(--space-3\)/,
    'nothing gives a settings group the interface gap from the element that holds it');

  // One value, declared once. A second top margin for a group would be a second
  // owner of the surface's rhythm, which is how the gap this file is about comes
  // back as a number nobody can move without moving two places.
  const declared = [...css.matchAll(/\.settings-group[^{]*\{[^}]*margin-top:\s*([^;}]+)/g)]
    .map((m) => m[1].trim());
  assert.deepEqual(declared, ['var(--space-3)'],
    `the gap above a settings group is declared ${declared.length} times: ${JSON.stringify(declared)}`);
});

test('every text line in the header declares its own inset from the header edge', () => {
  // The misalignment Abi reported, in the stylesheet's terms: the heading and its
  // subtitle did not share a leading edge. The title is upstream's rule and insets
  // itself 9px inside the header's own 12px padding; the subtitle is OURS (upstream
  // has no subtitle in this header) and took the header's padding alone, so it
  // started 9px to the left of the title and of the back control's icon. The block
  // read as two columns.
  //
  // So this asserts the agreement rather than either number: the two text rules in
  // the header inset themselves to the SAME edge, which is the property that broke.
  // A third line added later without an inset of its own is caught by the rendered
  // guard, not here.
  const css = read(REPO, 'core', 'ui', 'ui.css').replace(/\/\*[\s\S]*?\*\//g, '');
  const inlinePadding = (selector) => {
    const rule = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(css);
    assert.ok(rule, `${selector} is not declared in ui.css at all`);
    const padding = /padding:\s*([^;}]+)/.exec(rule[1]);
    assert.ok(padding, `${selector} declares no padding, so it sits on the header's outer edge`);
    const parts = padding[1].trim().split(/\s+/);
    return parts.length === 1 ? parts[0] : parts.length === 2 ? parts[1] : parts.length === 3 ? parts[1] : parts[3];
  };
  const title = inlinePadding('.settings-sidebar__title');
  const subtitle = inlinePadding('.modal__header .sub');
  assert.notEqual(title, '0px', 'the title no longer insets itself from the header padding');
  assert.equal(subtitle, title,
    `the subtitle is inset ${subtitle} where the title is inset ${title}: the header's text is on two edges again`);
});

test('the Control-UI settings card is one node, outside every panel, beside About', () => {
  // It was inside the Gateways panel, which is a card nobody on the Certificates
  // tab can see, and the fix is a move rather than a second copy: one node, in the
  // footer with About, on screen whichever tab is showing.
  const copies = html.split('id="control-ui-settings"').length - 1;
  assert.equal(copies, 1, `the card appears ${copies} times in settings.html`);

  const cardAt = html.indexOf('id="control-ui-settings"');
  const prefsEnd = html.lastIndexOf('</section>');
  assert.ok(prefsEnd > 0 && cardAt > prefsEnd,
    'the card is still inside a panel, so it is still only on one tab');

  const footerAt = html.indexOf('id="about-footer"');
  assert.ok(footerAt > cardAt, 'the About footer no longer follows the card, so they are not together');
  const between = html.slice(cardAt, footerAt);
  assert.ok(!/class="panel"/.test(between), 'a panel still opens between the card and the footer');

  // The existing card and its one action, reused: a second button for one command
  // would be a second thing to keep wired.
  assert.equal(html.split('id="open-control-ui-settings"').length - 1, 1,
    'the card has more than one action button');
  assert.equal((page.match(/\$\('control-ui-settings'\)/g) || []).length, 1,
    'the page looks up more than one copy of the card');
});

test('the measured half of this still asks the phone\'s question, on both pages', () => {
  // The spacing and the alignment are claims about boxes, so the assertions above
  // are about the SHAPE of the rules and the boxes are measured by
  // scripts/test-settings-layout.js. Nothing runs that harness automatically: the
  // suite is plain Node and cannot render a page. So this checks that the harness
  // is still the guard its report says it is, which is the only thing standing
  // between a gutted harness and a fault nobody can see in a diff.
  const harness = read(DESKTOP, 'scripts', 'test-settings-layout.js');
  const widths = [...harness.matchAll(/width:\s*(\d+)/g)].map((m) => Number(m[1]));
  assert.ok(widths.some((w) => w <= 601), `the narrow pass is gone: widths ${JSON.stringify(widths)}`);
  assert.ok(widths.some((w) => w >= 700), `the wide pass is gone: widths ${JSON.stringify(widths)}`);
  // The pages: settings, plus About, which carries the same borrowed header.
  assert.match(harness, /file: 'settings\.html'/, 'the harness no longer loads the settings page');
  assert.match(harness, /file: 'about\.html'/, 'the harness no longer loads the other page with this header');
  // Both appearances, and the two claims: the blocks separated, the header's text on one edge.
  assert.match(harness, /\['light', 'dark'\]/, 'the harness no longer captures both appearances');
  assert.match(harness, /no two blocks of the settings surface are flush/,
    'the harness no longer asserts that the surface\'s blocks are separated');
  assert.match(harness, /share one leading edge/, 'the harness no longer asserts the header\'s leading edge');
});

/* ---------------------------------------- the handoff to the Control UI */

// "Go to the Control UI" takes the reader from OUR settings surface to the
// Control UI's own. It used to CLOSE this surface first and ask second, so the
// reader was returned to whatever the Control UI had been showing and watched it
// for the whole of the destination's load, a visible few seconds, before the
// settings page painted. The destination was never wrong; the journey showed them
// a page they had not asked for.
//
// What is asserted here is the SHAPE of the fix, in this file's own split: that
// the reveal comes after a wait, that the wait is bounded and conditional, and
// that nothing dismisses the surface early. What the transition actually LOOKS
// like is a claim about a composited window, which no static reading can make, so
// it is measured by scripts/test-affordance-placement.js, and the last test here
// checks that the harness is still carrying that proof.

/** The body of a top-level function, by its opening line. */
function functionBody(source, signature) {
  const start = source.indexOf(signature);
  assert.ok(start >= 0, `${signature} is gone from the source`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    else if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced braces after ${signature}`);
}

test('the handoff reveals the destination only once it is ready', () => {
  const main = read(DESKTOP, 'src', 'main.js');
  const body = functionBody(main, 'async function openControlUiSettings(');

  // The ask is unchanged: the Control UI's own control or its own route, from the
  // shared script, rather than a URL this client builds.
  assert.match(body, /controlUiSettingsSource\(\)/, 'the ask is no longer the shared script\'s');
  assert.ok(!/location\s*=\s*|loadURL\(/.test(body), 'the client is building its own navigation again');

  // The fix, as an ORDER: on the path that has somewhere to go, the wait is
  // awaited and only then does the surface go away. A `closeSettings()` that ran
  // before the wait is the bug, and it reads as correct in a diff that does not
  // compare positions.
  const waited = body.indexOf('await waitForControlUiSettings(');
  assert.ok(waited >= 0, 'nothing waits for the destination any more');

  // Exactly two dismissals, and each one is accounted for: the early-out, which
  // runs only when there is no gateway page behind the surface at all (a first run,
  // where the card that carries this is hidden anyway), and the reveal.
  const dismissals = [...body.matchAll(/closeSettings\(\)/g)].map((m) => m.index);
  assert.equal(dismissals.length, 2, `closeSettings() appears ${dismissals.length} times`);
  const reveal = dismissals[dismissals.length - 1];
  assert.ok(reveal > waited, 'the surface is dismissed BEFORE the destination is waited for');

  // The early-out is the one that is NOT the reveal, and it is guarded by there
  // being no page to hand off to. Unguarded, it would dismiss the surface on the
  // path this whole change is about.
  const earlyOut = dismissals[0];
  const guard = body.lastIndexOf('if (!wc)', earlyOut);
  assert.ok(guard >= 0 && earlyOut - guard < 60, 'a dismissal runs unguarded before the wait');

  // And the reveal is the last thing that happens, so no later statement can
  // quietly undo it or put the surface back.
  assert.ok(body.slice(reveal).replace(/\s+$/, '').length < 40,
    'the reveal is no longer the last statement of the handoff');

  // Conditional on the ask having gone somewhere, so a Control UI with nothing to
  // press does not hold the reader for the whole deadline.
  assert.match(body, /if \(asked === true\) await waitForControlUiSettings\(wc\);/,
    'the wait is no longer conditional on the ask having asked for something');
});

test('the wait is bounded by the shared deadline, and cannot end early', () => {
  const main = read(DESKTOP, 'src', 'main.js');
  const body = functionBody(main, 'function waitForControlUiSettings(');

  // The numbers are the spec's, so the phone holds the same line.
  assert.match(body, /CONTROL_UI_SETTINGS_READY_TIMEOUT_MS/, 'the deadline is no longer the spec\'s');
  assert.match(body, /CONTROL_UI_SETTINGS_POLL_MS/, 'the interval is no longer the spec\'s');
  // It must resolve on BOTH answers. A waiter that only ever resolved on ready
  // would hold the reader behind our surface forever on a Control UI that never
  // arrives, which is a worse fault than the one being fixed.
  assert.match(body, /resolve\(false\)/, 'the wait can no longer give up, so a broken destination traps the reader');
  // A page that goes away mid-wait is an answer, not a hang.
  assert.match(body, /isDestroyed\(\)/, 'a destroyed page no longer ends the wait');
  // Every path that is not a yes re-asks rather than concluding.
  assert.match(body, /then\(\(ready\)/, 'the readiness answer is no longer read');
});

test('the measured half of the handoff is still a proof of the transition', () => {
  // The same shape as the test above it, and for the same reason: the claim is
  // about what is on screen DURING the handoff, which needs a composited window. A
  // harness that stopped capturing frames, or stopped asserting the intermediate
  // view, would go on printing OK.
  const harness = read(DESKTOP, 'scripts', 'test-affordance-placement.js');
  assert.match(harness, /no frame showed a view the reader did not ask for/,
    'the harness no longer asserts that no intermediate view was shown');
  assert.match(harness, /after the click/, 'the harness no longer measures the gap');
  assert.match(harness, /openControlUiSettings|open-control-ui-settings/,
    'the harness no longer drives the handoff at all');
  // The frame half, which is what makes it a capture rather than a pair of reads.
  assert.match(harness, /frameDiff\(/, 'the harness no longer compares frames');
  assert.match(harness, /transition-before|transition-revealed/, 'the harness no longer captures the transition');
});

test('the gateway section is ONE section with ONE Save, and says what an empty field means', () => {
  // Reported, and this is the shape it was reported against: "Right now it's very
  // segmented and there are multiple save buttons." Measured off the rendered page
  // before this change, the editor offered
  // ["Save","Clear","Save","Clear","Add header","Save name and address"]: four
  // places to press for one job.
  //
  // That shape was a DELIBERATE choice, and this test exists because it is being
  // REVERSED rather than repaired. Each credential had its own Save and Clear, and
  // the name and address had a third Save under them, on the reasoning that a
  // control next to the thing it writes is clearer than one at the end. The
  // reasoning is what was wrong: a person configuring one gateway is doing one
  // thing, and several identically-shaped buttons make that one task read as
  // several, with the press having to be guessed at from whichever button is
  // nearest. So the per-field pair is gone and there is ONE Save.
  //
  // Two things came with the single Save, and both are asserted here rather than
  // left to the screenshots, because neither is a property of the layout:
  //
  //   - an EMPTY field means "leave it alone", which has to be SAID, since a single
  //     Save over several fields is what makes a partial save the ordinary case;
  //   - a stored credential still has to be removable, and the control that does it
  //     is now a button of its own (see the test below).
  //
  // What this file can hold is the shape of the code. The button COUNT on a real
  // rendered page, in both appearances, is measured by scripts/capture-gateway-form.js.
  const code = codeOnly(page);

  const editor = /function gatewayEditor\(gw\) \{[\s\S]*?\n\}/.exec(code);
  assert.ok(editor, 'the editor is no longer built by a function this test can read');
  assert.strictEqual([...editor[0].matchAll(/textContent: 'Save'/g)].length, 1,
    'the editor does not offer exactly one Save');

  // Gone, and named one at a time so a diff shows which one came back. The filter
  // field above the list still has a Clear of its own; that one is markup in
  // settings.html and belongs to the search box rather than to a gateway's fields.
  assert.doesNotMatch(code, /function credentialButtons\(/,
    'the per-field Save and Clear are back');
  assert.doesNotMatch(code, /textContent: 'Clear'/, 'a Clear button is back on this page');
  assert.doesNotMatch(code, /textContent: 'Add header'/,
    'adding a header is a second, differently-shaped save again');

  // What a partly filled form does, on both forms. A sentence in the interface is
  // the interface for this: the alternative is a reader finding out by watching a
  // stored value disappear.
  assert.match(code, /A field left empty is kept as it is/,
    'the editor does not say what an empty field is taken to mean');
  assert.match(code, /a field left blank is simply not set/,
    'the create form does not say what a blank field is taken to mean');

  // And the save writes only what was filled, which is what makes that sentence
  // true rather than decorative: setCredentials CLEARS a credential when it is
  // handed a blank string, so a save that wrote every field would delete a stored
  // token on any save where the reader had not retyped it.
  const save = /async function saveEditedGateway\(gw, fields, out\) \{[\s\S]*?\n\}/.exec(code);
  assert.ok(save, 'the editor no longer saves through a function this test can read');
  assert.match(save[0], /if \(fields\.token\.value\) creds\.token = fields\.token\.value/,
    'the editor writes the token field whether or not it was filled');
  assert.match(save[0], /call\('updateGateway', gw\.id, \{ label, url \}\)/,
    'the one press no longer writes the name and address');
  assert.match(save[0], /call\('addHeader', gw\.id, fields\.headerName\.value/,
    'the one press no longer stores a typed header');
  // And it reports what it kept, because a save that quietly dropped a credential
  // reads exactly like one that stored it.
  assert.match(save[0], /Stored its new/, 'the one press reports nothing about what it stored');
});

test('a stored credential is still removable, by a control that names it', () => {
  // The per-field Clear went with the per-field Save, so this is the half of the
  // reversal that had to be answered rather than inherited: what takes a stored
  // credential back out now?
  //
  // The choice is a control of its own beside the field it empties, acting on its
  // own press, and the alternative was rejected deliberately. "Empty the field and
  // save" was the other option, and under ONE Save it is unsafe: an empty field
  // means "leave this alone" everywhere else in the section, so reading an empty
  // one as an instruction to DELETE makes typing nothing the destructive action,
  // and a reader who edits only the name would take the token with it. It is
  // reasoned in full on \`credential\` in core/ui/settings.js; this holds the
  // behaviour it produces.
  //
  // Demonstrated rather than asserted, by scripts/test-edit-and-remove-credential.js:
  // it creates a gateway with a token, watches the app hand that token to a stub
  // gateway, presses this control, and watches the next connection carry no token
  // at all.
  const code = codeOnly(page);
  assert.match(code, /textContent: `Remove saved \$\{word\}`/,
    'nothing on the page offers to remove a stored credential');
  assert.match(code, /const remove = mode === 'stored' && has/,
    'the removal control is not tied to a credential actually being stored');
  assert.match(code, /call\('setCredentials', gw\.id, \{ \[key\]: '' \}\)/,
    'the removal does not clear the credential through the store that keeps it');
  assert.match(code, /setEditorAnswer\(gw, out, res\.saved\.ok/,
    'the removal reports nothing, so a press that worked would read as one that did nothing');
  // And a stored credential says so beside its field, which is the state the
  // control appears in: the placeholder carries it inside the field, and the hint
  // carries it in words.
  assert.match(code, /A token is saved for this gateway\./, 'the token field does not report a stored value');
});

test('every preference on this tab commits from its own control', () => {
  // The fifth rule in ui/CONVENTIONS.md, and the report it came from: one button at
  // the foot of the tab wrote every preference, so the screen and the stored state
  // could disagree for as long as the reader stayed on the page, and every control
  // carried "have I saved this?" while they were still using it.
  assert.doesNotMatch(html, /id="save"/, 'the Save control is back in the markup');
  assert.doesNotMatch(page, /'save'\)\.addEventListener/, 'the page still wires a Save button');
  assert.match(page, /async function commitSetting\(id, value, done = ''\)/,
    'there is no single per-row commit');

  // The switches, read from the spec rather than typed here: a setting added there
  // has to be wired, and one removed from it must not stay wired to a row that is
  // gone. The order is the page's business, so the lists are compared as sets.
  const wired = /for \(const id of \[([^\]]*)\]\)/.exec(page);
  assert.ok(wired, 'no switch list to check');
  const listed = wired[1].split(',').map((entry) => entry.trim().replace(/'/g, '')).sort();
  const declared = spec.settings.map((setting) => setting.id)
    .filter((id) => id !== 'globalShortcut' && id !== 'gatewayHeaders' && id !== 'appearance')
    .sort();
  assert.deepStrictEqual(listed, declared,
    'the switches the page commits from are not the ones the spec declares');

  // And the one preference with nothing to show for itself commits on the reader's
  // own gesture, both of them: Enter, and leaving the field having changed it.
  assert.match(page, /shortcut\.addEventListener\('keydown'/, 'the shortcut field has no Enter');
  assert.match(page, /shortcut\.addEventListener\('blur'/, 'the shortcut field does not commit when it is left');
  assert.match(html, /id="globalShortcut-result"/, 'the row that must report has nowhere to report to');
});

