'use strict';

// The About box, and the ONE copy of it. Same shape as settings.js: nodes are
// built rather than assigned as innerHTML, and every value comes from the host
// already formatted, because this page is sandboxed and cannot require
// src/updates.js or src/build-info.js. Formatting here would mean a second copy
// of those rules that drifts the first time either changes.
//
// TWO clients render this page now, for the same reason the settings page has
// two: the desktop loads it in an overlay view (`window.clawDesktop`, installed
// over IPC in desktop/src/preload.cjs), and the iOS app loads the same file out
// of its bundle in a sheet (`window.clawDesktop`, installed over a
// WKScriptMessageHandler in mobile/Claw/AboutHost.swift). About was reachable
// only from a native menu bar before, which iOS has none of and the Windows
// desktop hides behind an Alt press, so it now hangs off Settings, which every
// client can reach. Nothing here branches on which client it is: the facts a
// build reports are the host's to describe (the desktop says Electron and a
// Chromium version, the phone says its iOS version and device), so they arrive
// as `state.facts` rather than being hardcoded here, the same way the settings
// page reads its own runtime line from the host.

const api = window.clawDesktop;
if (!api || typeof api.about !== 'function') {
  // Only ever loaded by a client, and a client that installs no host has a boot
  // fault worth failing loudly for, the same as the settings page.
  throw new Error('about page loaded without a clawDesktop host');
}
const $ = (id) => document.getElementById(id);

if (new URLSearchParams(location.search).has('frameless')) document.body.classList.add('frameless');

function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of [].concat(children)) if (child) node.append(child);
  return node;
}

function fact(label, value) {
  return el('div', { className: 'fact' }, [
    el('span', { className: 'fact__label', textContent: label }),
    el('span', { className: 'fact__value mono', textContent: value }),
  ]);
}

/**
 * The Control UI this build targets, as the one line About shows for it.
 *
 * The two fields come from the pin that records which upstream revision our
 * borrowed components came out of (core/spec/upstream-reference.json). The line
 * is composed HERE rather than by each host, and that is the whole reason this
 * function exists: both clients render this page, so a sentence written in
 * src/main.js and another written in AboutHost.swift would be two sentences about
 * one revision, and the one nobody looked at would be the one that went stale.
 * No version is ever typed into this file.
 *
 * Ten characters of the commit, the same length the app stamps its own build line
 * with (SHORT_LENGTH in desktop/src/build-info.js), so the line above and this one
 * read alike, and a commit is what tells two builds of one release apart: the
 * number names a release, the sha names the revision.
 */
function controlUILine(reference) {
  const version = reference && reference.version ? String(reference.version) : '';
  if (!version) return '';
  const sha = reference && typeof reference.commit === 'string' ? reference.commit.slice(0, 10) : '';
  return sha ? `${version} (${sha})` : version;
}

function render(state) {
  $('build').textContent = state.build;
  $('update-status').textContent = state.updateStatus;
  // The status line says what is happening. This says what to do about it,
  // which is the part someone opening About while suspicious is looking for.
  const hint = state.updateReady
    ? `Version ${state.updateReady} is downloaded, install it from the tray or the menu bar.`
    : (state.canInstall && !state.autoUpdate
      ? 'Automatic updates are off. Turn on “Install updates automatically” in Settings to have new versions applied without asking.'
      : '');
  $('update-hint').textContent = hint;
  $('update-hint').hidden = !hint;

  // The facts a bug report asks for, formatted by the host: which build this is,
  // what it runs on. The list is the host's rather than this page's because what
  // a client runs on is that client's to describe, and a desktop fact
  // (Electron, Chromium) has no meaning on the phone and the phone's (its iOS
  // version, its device) has none on the desktop. Each entry is a
  // `{ label, value }` pair, already stringified.
  const facts = Array.isArray(state.facts) ? state.facts : [];
  const rows = facts.map((f) => fact(f.label, f.value));

  // Which Control UI this build targets, in the same list as the other build
  // facts. It sits at the end because the rows above it are this client's own
  // (its version, the runtime a rendering bug would be blamed on) and this one is
  // about someone else's code that the client wraps and depends on, so a reader
  // scanning for "what am I running" is answered before "what does it render".
  //
  // Drawn only when the host hands it over: a host with no pin behind it passes
  // nothing, and a row about a reference nothing recorded would be worse than no
  // row at all. That absence is a failing test in every suite that reads this
  // surface, not something the page should invent a value for.
  const line = controlUILine(state.controlUI);
  if (line) rows.push(fact('Control UI', line));

  $('facts').replaceChildren(...rows);
}

async function refresh() {
  render(await api.about());
}

/* --------------------------------------------------------------- listeners */

$('check').addEventListener('click', async () => {
  const out = $('check-result');
  out.textContent = 'Checking…';
  out.className = 'result';
  await api.checkUpdates();
  // The result arrives as its own message dialog, and the status line above
  // refreshes itself through onAboutChanged, so all this has to do is stop
  // saying "Checking…" if the check never comes back at all.
  setTimeout(() => { if (out.textContent === 'Checking…') out.textContent = ''; }, 15000);
});

$('releases').addEventListener('click', () => api.openReleases());

const dismiss = () => api.closeOverlay('about');
$('close').addEventListener('click', dismiss);
// Only a click that both starts and ends on the scrim counts, so releasing the
// mouse outside the card after selecting text inside it does not close it.
$('scrim').addEventListener('mousedown', (e) => {
  if (e.target !== e.currentTarget) return;
  $('scrim').addEventListener('mouseup', (ev) => { if (ev.target === e.currentTarget) dismiss(); }, { once: true });
});
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') dismiss(); });

// Pushed by the main process whenever a check finishes. Without it, clicking
// "Check for updates" would leave the line above the button still saying "no
// check yet this run", the question this box exists to answer, answered
// wrongly, immediately after the user did the thing that changed it.
api.onAboutChanged(() => {
  const out = $('check-result');
  if (out.textContent === 'Checking…') out.textContent = '';
  void refresh();
});

void refresh();
