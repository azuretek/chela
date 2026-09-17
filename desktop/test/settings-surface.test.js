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
