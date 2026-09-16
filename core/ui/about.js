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
  $('facts').replaceChildren(...facts.map((f) => fact(f.label, f.value)));
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
