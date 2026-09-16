'use strict';

// The device-approval screen. Same shape as the other pages here: nodes are
// addressed by id and every value comes from the main process, because this page
// is sandboxed and cannot require core/pairing.js. It holds no rule of its own
// about what counts as pairing, which is what lets a second client render these
// same bytes from its own host.
//
// It renders ONE state, because it is only ever shown in one: the client is
// refused until an operator approves it. There is no dismiss. The screen's whole
// job is to make the refusal visible, and a screen you can wave away would put
// the user back on a page that has nothing to show them.

const api = window.clawDesktop;
if (!api || typeof api.pairing !== 'function') {
  // Only ever loaded by a client, and a client that installs no host has a boot
  // fault worth failing loudly for, the same as the settings and About pages.
  throw new Error('pairing page loaded without a clawDesktop host');
}

const $ = (id) => document.getElementById(id);

if (new URLSearchParams(location.search).has('frameless')) document.body.classList.add('frameless');

function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of [].concat(children)) if (child) node.append(child);
  return node;
}

/** One label/value row, the shape About's facts use. */
function fact(label, value) {
  return el('div', { className: 'fact' }, [
    el('span', { className: 'fact__label', textContent: label }),
    el('span', { className: 'fact__value mono', textContent: value }),
  ]);
}

function render(state) {
  $('title').textContent = state.title;
  $('body').textContent = state.body;
  $('requirement').textContent = state.requirement;
  $('waiting').textContent = state.waiting;
  $('note').textContent = state.cannotRunHere;

  // The request id is the thing the operator matches, so it is shown when the
  // gateway gave one; without it the command falls back to `--latest`, which the
  // host has already chosen, and the row would have nothing to say.
  const details = $('details');
  details.replaceChildren();
  if (state.requestId) details.append(fact(state.requestIdLabel, state.requestId));
  if (state.device) details.append(fact(state.deviceIdLabel, state.device));

  $('command-label').textContent = state.commandLabel;
  $('command').textContent = state.command;

  const docs = $('docs');
  if (state.docsHref) docs.href = state.docsHref;
  else docs.hidden = true;
}

async function refresh() {
  render(await api.pairing());
}

// The screen moves when the phase does, and the phase moves under it: the host
// pushes on every transition, so the screen never has to poll for its own copy.
$('retry').addEventListener('click', () => { void api.reconnect(); });
api.onPairingChanged(() => { void refresh(); });

void refresh();
