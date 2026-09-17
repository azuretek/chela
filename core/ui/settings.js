'use strict';

/*
 * The settings surface, for whichever client is running it.
 *
 * ONE page, TWO clients. This file is the only implementation of the settings
 * UI in the repo: the desktop loads it in an overlay view (or, on a first run,
 * as the window's own content), and the iOS app loads the same file out of its
 * bundle in a sheet. There is no native settings screen on the phone and no
 * second copy of any tab, which is the whole reason this lives in core/ rather
 * than beside either client: two implementations would be two things to keep in
 * step, and the tokens, the notices and the gateway rules are already shared for
 * exactly that reason.
 *
 * What differs between the clients is therefore NOT in here. The host supplies
 * the state, and `state.client` plus the copy of core/spec/settings.json that
 * host handed over say which tabs and which settings this client has. Anything
 * this client does not have is hidden rather than specially cased, so a desktop
 * setting cannot be reimplemented on the phone by accident: it would have to be
 * added to that spec first.
 *
 * The host itself is `window.clawSettings`, installed before this script runs.
 * One door, `invoke(command, args)`, plus `on(event, handler)`: desktop builds it
 * in desktop/src/preload.cjs over IPC, and iOS builds it over a
 * WKScriptMessageHandler in mobile/Claw/SettingsHost.swift. A named method here
 * would have to be mirrored in Swift, which is why there is one.
 */

const host = window.clawSettings;
if (!host || typeof host.invoke !== 'function') {
  // Only ever loaded by a client, and a client that installs no host has a boot
  // fault worth failing loudly for: the alternative is a page whose every button
  // silently does nothing.
  throw new Error('settings page loaded without a clawSettings host');
}

/** One command on the host, as a promise. Never called before `state` is read. */
function call(command, ...args) {
  return host.invoke(command, args);
}

/** Subscribe to one host event. */
function on(event, handler) {
  return host.on(event, handler);
}

const params = new URLSearchParams(location.search);
const firstRun = params.has('firstRun');
// This page is the window's own content rather than a dialog over it, which on
// the desktop is a first run and nothing else now (a failed connection leaves you
// where you were and raises a notice), and on iOS is the state with no gateway
// configured at all, where there is nothing behind the page to go back to. Kept
// separate from firstRun, which additionally hides the preferences, so the two can
// differ again.
//
// The URL is where the desktop says this, because a decision that changes where
// the card sits belongs before first paint. iOS cannot: a query on a file URL
// renders a blank document in its web view, which took a white screen and a
// simulator to find. So its host states the same fact on the host object, at
// document start, which lands at the same moment. See the bootstrap in
// mobile/Claw/SettingsHost.swift.
const asPage = params.has('page') || host.asPage === true;
const $ = (id) => document.getElementById(id);

// Applied before first paint, from the URL rather than from a getState(), because
// these decide where the card sits and whether it is a dialog or the window
// itself. Fetched over the host they land after the first frame and the card
// jumps. (This script is the last element in <body>, so document.body exists.)
if (params.has('frameless')) document.body.classList.add('frameless');
if (asPage) document.body.classList.add('as-page');
if (firstRun) document.body.classList.add('first-run');

let state = null;
// Which gateway's credential editor is open. Kept across re-renders so saving a
// field does not collapse the panel you are working in.
let editing = null;
// The failure log, once read. Null is not the same as empty: an empty section
// drawn before the answer arrives says nothing has ever gone wrong, and that is
// a claim this page has no business making until it has looked.
let history = null;
let gatewayFilterText = '';

/* Build DOM nodes rather than assigning innerHTML: labels and URLs are
   user-supplied strings, and this page has no business parsing them as HTML. */
function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of [].concat(children)) if (child) node.append(child);
  return node;
}

/* A labelled field, in upstream's stacked-row shape: the title and its
   description in one column, the control under them at full width. It was a
   label above a control with a hint line under both, which is a different
   rhythm from every row around it and is why an input never lined up with the
   settings above it.

   No inline style attributes anywhere on this page: settings.html sets
   `style-src 'self'`, which CSP applies to style attributes too. */
function field(labelText, control, hint) {
  return el('div', { className: 'settings-row settings-row--stacked' }, [
    el('div', { className: 'settings-row__text' }, [
      el('span', { className: 'settings-row__title', textContent: labelText }),
      hint ? el('span', { className: 'settings-row__desc', textContent: hint }) : null,
    ]),
    el('div', { className: 'settings-row__control' }, [control]),
  ]);
}

/* ------------------------------------------------------------- the surface */

/**
 * The half of the settings surface this client has.
 *
 * From core/spec/settings.json, which the host hands over as it stands, so the
 * split has one owner and this page is not a second one. Filtering here rather
 * than in each host is what keeps the hosts thin: all a host has to know is which
 * client it is.
 */
function surface() {
  const spec = (state && state.surface) || {};
  const client = state && state.client;
  const mine = (list) => (Array.isArray(list) ? list : []).filter((e) => (e.clients || []).includes(client));
  return {
    tabs: mine(spec.tabs),
    settings: mine(spec.settings),
    commands: mine(spec.commands),
  };
}

function surfaceTabIds() {
  return surface().tabs.map((t) => t.id);
}

function hasSetting(id) {
  return surface().settings.some((s) => s.id === id);
}

/** Whether this client's host answers a command at all. */
function hasCommand(id) {
  return surface().commands.some((c) => c.id === id);
}

/**
 * Hide the settings this client does not have.
 *
 * Hidden rather than deleted: this is one document rendering both clients, and
 * reaching into it to remove nodes would leave the two clients rendering from two
 * different documents while still calling it shared. The markup carries
 * `data-setting` for every setting the clients use between them, and
 * desktop/test/settings-surface.test.js asserts those ids and the spec agree in
 * both directions, so a setting cannot be added to one and forgotten in the
 * other.
 */
function applySurface() {
  const ids = new Set(surface().settings.map((s) => s.id));
  for (const node of document.querySelectorAll('[data-setting]')) {
    node.hidden = !ids.has(node.dataset.setting);
  }
  // A tab this client does not have is hidden here and skipped by showTab, so
  // neither the button nor the panel can be reached into.
  for (const id of ALL_TAB_IDS) {
    const button = $(`tab-${id}`);
    if (button) button.hidden = !surfaceTabIds().includes(id);
    const panel = $(`panel-${id}`);
    if (panel && !surfaceTabIds().includes(id)) panel.hidden = true;
  }
}

/* ---------------------------------------------------------------- gateways */

/**
 * Everything this app can store for a gateway, in ONE place and one order.
 *
 * BOTH flows render this: the "Add a gateway" form under the list, and the
 * editor that opens under a row. They used to be two shapes, and the difference
 * between them was the fault rather than a detail of it. The form took a name and
 * an address; the editor took a name, an address, a token, a password and
 * headers. So a gateway made on that form was half-configured from the moment it
 * existed, and finishing it meant finding its row again and pressing Edit. Two
 * shapes for one object is how a page comes to disagree with itself, so there is
 * one now, and both flows fill in the same fields.
 *
 * Nothing here writes anything. It hands back the rows and the controls and the
 * caller decides what to save, because the two flows save at genuinely different
 * moments: the editor writes each credential when its own Save is pressed, and
 * the add form writes everything in one pass, once there is a gateway to attach
 * it to.
 *
 * The credentials are write-only on both paths, so no value is ever read back:
 * every credential input starts empty and its placeholder carries the state
 * instead. `ids` is for the add form, which has to keep the element names its
 * own harnesses look for; the editor holds its own references and names none.
 *
 * @param {{label?: string, url?: string, credentials?: object}} gw the gateway, or blanks
 * @param {{mode: 'new'|'stored', ids?: object, out?: Element}} opts
 * @returns {{node: Element, name: Element, url: Element, token: Element,
 *            password: Element, headerName: Element, headerValue: Element}}
 */
function gatewayFields(gw, { mode, ids = {}, out = null }) {
  const creds = gw.credentials || { hasToken: false, hasPassword: false, headers: [] };
  const named = (id, props) => el('input', { ...(id ? { id } : {}), ...props });
  // A stored secret is never read back, so the state lives in the placeholder:
  // an input holding dots would be this page inventing a value it was never given.
  const stored = (has) => (mode === 'stored' && has ? 'Stored, type a new value to replace it' : 'Not set');

  const name = named(ids.label, { type: 'text', value: gw.label || '', placeholder: 'Name (e.g. home)', autocomplete: 'off' });
  const url = named(ids.url, { type: 'url', value: gw.url || '', placeholder: 'https://host.example.ts.net', autocomplete: 'off', spellcheck: false });
  const token = named(ids.token, { type: 'password', autocomplete: 'off', spellcheck: false, placeholder: stored(creds.hasToken) });
  const password = named(ids.password, { type: 'password', autocomplete: 'off', spellcheck: false, placeholder: stored(creds.hasPassword) });

  // The one thing a reader cannot find out by looking: a credential is only ever
  // proven by a connection. Editing an existing gateway, that answer already
  // arrived, because this gateway is on screen having been connected to. Creating
  // one, there is nothing to check against yet, so the field SAYS so rather than
  // being hidden or quietly accepted.
  const unprovable = mode === 'new'
    ? ' It cannot be checked here, only on the first connection, so a wrong one is reported then rather than now.'
    : '';

  // One row per credential, with its own Save and Clear directly under it when
  // there is a gateway to write to. The buttons belong to the field rather than
  // to the panel, which is what stops a row of three unexplained Save buttons.
  const credential = ({ key, title, has, control, hint }) => el('div', {}, [
    field(`${title}${mode === 'stored' && has ? ' · stored' : ''}`, control, hint),
    mode === 'stored'
      ? el('div', { className: 'settings-row settings-row--actions' }, [
        el('div', { className: 'settings-row__control' }, credentialButtons(gw, control, { key, title, has }, out)),
      ])
      : null,
  ]);

  const headers = hasSetting('gatewayHeaders') ? headerRows(gw, { mode, ids, out }) : null;

  return {
    node: el('div', {}, [
      field('Name', name, 'Optional. What this gateway is called in the list. Left empty, it is named after its address.'),
      field('Address', url, 'Required. The gateway’s own address, for example https://host.example.ts.net'),
      credential({
        key: 'token',
        title: 'Gateway token',
        has: creds.hasToken,
        control: token,
        hint: `Handed to the Control UI when you connect, so a gateway with a token never shows you a sign-in form. From \`openclaw gateway auth-token --show\` on that gateway.${unprovable}`,
      }),
      credential({
        key: 'password',
        title: 'Gateway password',
        has: creds.hasPassword,
        control: password,
        hint: 'Only for gateways in password mode. There is no URL handoff for passwords, so the app fills the sign-in form instead, best effort.',
      }),
      headers ? el('div', {}, [el('hr'), headers.node]) : null,
    ]),
    name,
    url,
    token,
    password,
    headerName: headers ? headers.name : null,
    headerValue: headers ? headers.value : null,
  };
}

/**
 * One credential's own Save and Clear, which belong to the field above them.
 *
 * Only the editor has these, and the reason is the store rather than the
 * surface: a credential is kept against a gateway's id, so there is nothing to
 * write one to until the gateway exists. The add form's one button saves its
 * credentials with everything else, in the same pass that creates it.
 */
function credentialButtons(gw, input, { key, title, has }, out) {
  const save = el('button', {
    className: 'primary',
    textContent: 'Save',
    onclick: async () => {
      if (!input.value) return setResult(out, 'Enter a value first.', 'err');
      const res = await call('setCredentials', gw.id, { [key]: input.value });
      state = res;
      input.value = '';
      setResult(out, res.saved.ok ? `${title} saved.` : res.saved.error, res.saved.ok ? 'ok' : 'err');
      render();
    },
  });

  const clear = el('button', {
    className: 'ghost danger',
    textContent: 'Clear',
    disabled: !has,
    onclick: async () => {
      const res = await call('setCredentials', gw.id, { [key]: '' });
      state = res;
      setResult(out, res.saved.ok ? `${title} cleared.` : res.saved.error, res.saved.ok ? 'ok' : 'err');
      render();
    },
  });

  return [save, clear];
}

/**
 * The extra request headers, which only a client that can set them shows.
 *
 * Marked with the spec's id like every other setting, and asked for by name
 * rather than built and hidden, because the half that hides it would still have
 * listed this gateway's stored header names on the phone, names the phone cannot
 * use and has no business displaying.
 *
 * The two flows differ in their ACTIONS here and never in their fields, which is
 * the same split the credentials keep: the editor has a gateway to write to, so
 * it lists what is stored and adds a header when asked. The add form has nothing
 * stored and no id to write against yet, so its one pair of inputs is saved by
 * the same press that creates the gateway.
 */
function headerRows(gw, { mode, ids = {}, out = null }) {
  const names = (gw.credentials && gw.credentials.headers) || [];

  const name = el('input', { ...(ids.headerName ? { id: ids.headerName } : {}), type: 'text', placeholder: 'CF-Access-Client-Id', autocomplete: 'off', spellcheck: false });
  const value = el('input', { ...(ids.headerValue ? { id: ids.headerValue } : {}), type: 'password', placeholder: 'value', autocomplete: 'off', spellcheck: false });

  // Our own inline cluster, kept as one: the controls that belong on one line,
  // where upstream's actions row would wrap them onto three.
  const controls = mode === 'stored'
    ? [name, value, el('button', {
      textContent: 'Add header',
      onclick: async () => {
        if (!name.value.trim()) return setResult(out, 'Enter a header name.', 'err');
        const res = await call('addHeader', gw.id, name.value, value.value);
        state = res;
        if (res.saved.ok) { name.value = ''; value.value = ''; }
        setResult(out, res.saved.ok ? 'Header saved.' : res.saved.error, res.saved.ok ? 'ok' : 'err');
        render();
      },
    })]
    : [name, value];

  // Only in the editor: the add form has no gateway yet, so there is nothing
  // stored to list and listing "none" would be a second empty state to read past.
  const stored = mode === 'stored'
    ? el('div', {}, names.length
      ? names.map((headerName) => el('div', { className: 'settings-row' }, [
        el('span', { className: 'url settings-row__text', textContent: `${headerName}: ••••••••` }),
        el('div', { className: 'settings-row__control' }, [
          el('button', {
            className: 'ghost danger',
            textContent: 'Remove',
            onclick: async () => {
              const res = await call('removeHeader', gw.id, headerName);
              state = res;
              setResult(out, res.saved.ok ? `Removed ${headerName}.` : res.saved.error, res.saved.ok ? 'ok' : 'err');
              render();
            },
          }),
        ]),
      ]))
      : el('div', { className: 'muted-sm', textContent: 'No extra headers.' }))
    : null;

  const box = el('div', {}, [
    el('div', { className: 'settings-row settings-row--stacked' }, [
      el('div', { className: 'settings-row__text' }, [
        el('span', { className: 'settings-row__title', textContent: 'Extra request headers' }),
        el('span', {
          className: 'settings-row__desc',
          textContent: 'Sent only to this gateway’s own origin. Use for Cloudflare Access or an authenticating reverse proxy.',
        }),
      ]),
      el('div', { className: 'settings-row__control' }, [stored]),
    ]),
    el('div', { className: 'settings-row settings-row--actions' }, [
      el('div', { className: 'settings-row__control' }, [el('div', { className: 'row' }, controls)]),
    ]),
  ]);
  box.setAttribute('data-setting', 'gatewayHeaders');
  return { node: box, name, value };
}

/**
 * One stored gateway's own panel, over the page it belongs to.
 *
 * The fields are not built here: they are `gatewayFields` in its stored state,
 * the same builder the add form uses, so the two cannot come to offer different
 * things. What this adds is what only an existing gateway can have, meaning the
 * credentials' own Save and Clear (a credential is kept against a gateway's id,
 * which does not exist until the gateway does) and the note that a new address
 * takes effect on the next connect rather than now.
 */
function gatewayEditor(gw) {
  const out = el('div', { className: 'result' });
  const fields = gatewayFields(gw, { mode: 'stored', out });

  const saveAddress = el('button', {
    className: 'primary',
    // Named for the two fields it writes. It was "Save address" while it saved
    // the name as well, beside two other Save buttons that saved a credential
    // each, so a press had to be guessed at from the button nearest it.
    textContent: 'Save name and address',
    onclick: async () => {
      if (!fields.url.value.trim()) return setResult(out, 'Enter an address first.', 'err');
      state = await call('updateGateway', gw.id, { label: fields.name.value.trim(), url: fields.url.value.trim() });
      setResult(out, 'Saved. Reconnect to use the new address.', 'ok');
      render();
    },
  });

  return el('div', { className: 'editor' }, [
    fields.node,
    el('div', { className: 'settings-row settings-row--actions' }, [
      el('div', { className: 'settings-row__control' }, [saveAddress]),
    ]),
    out,
  ]);
}

/**
 * Whether the gateway has approved this device: 'approved', 'pending' or null.
 *
 * Read from the connection phase, which is the same state the row's "Needs
 * approval" badge is drawn from, rather than from a second check of its own:
 * there is one answer to "is this device approved" and it already exists. The
 * phase is `pending` exactly while the gateway is holding this device's
 * approval, and `connected` is only reached by a socket that survived the
 * pairing settle window, which is the approval landing.
 *
 * Every other phase says nothing either way, and this answers null there rather
 * than guessing: `idle`, `connecting` and `failed` describe an attempt, not a
 * verdict, and a row that claimed approval from one of them would be making the
 * same kind of statement the line above used to make.
 *
 * Which gateway a phase belongs to is the host's own rule (the gateway the
 * connection is aimed at), so both halves are checked: a row for a gateway this
 * app is not pointed at has no phase to read.
 */
function deviceApproval(gw) {
  const conn = state.connection || {};
  if (gw.id !== state.activeGatewayId || gw.id !== conn.gatewayId) return null;
  if (conn.phase === 'pending') return 'pending';
  if (conn.phase === 'connected') return 'approved';
  return null;
}

function renderGateways() {
  const host = $('gateways');
  host.replaceChildren();
  const phase = (state.connection && state.connection.phase) || 'idle';

  if (state.secretsError) {
    host.append(el('div', { className: 'settings-group' }, el('div', { className: 'result err', textContent: state.secretsError })));
  }

  const all = state.gateways || [];
  const q = gatewayFilterText.trim().toLowerCase();
  const clearDisabled = q.length === 0;
  if (clearFilter) clearFilter.disabled = clearDisabled;
  const match = (gw) => {
    if (!q) return true;
    const label = String(gw.label || '').toLowerCase();
    const url = String(gw.url || '').toLowerCase();
    return label.includes(q) || url.includes(q);
  };
  const activeGw = state.activeGatewayId ? all.find((g) => g.id === state.activeGatewayId) : null;
  const filtered = q ? all.filter(match) : all;
  // Keep the active gateway visible so "Reconnect" and its editor are still accessible
  // even when it doesn't match the current filter.
  const shown = (q && activeGw && !filtered.some((g) => g.id === activeGw.id))
    ? [activeGw, ...filtered]
    : filtered;

  if (!all.length) {
    host.append(el('div', { className: 'settings-group empty', textContent: 'No gateways yet. Add one below.' }));
    return;
  }

  if (!shown.length) {
    host.append(el('div', { className: 'settings-group empty', textContent: 'No gateways match your filter.' }));
    return;
  }

  for (const gw of shown) {
    const active = gw.id === state.activeGatewayId;
    const open = editing === gw.id;
    const creds = gw.credentials || { hasToken: false, hasPassword: false, headers: [] };

    // A one-line summary of what this app holds for this gateway and whether the
    // gateway has approved this device, so the list answers "why is this one
    // still asking me to sign in?" without opening the editor.
    //
    // Two facts, both already known here, and neither derivable from the other:
    // the credential summary the host sends (all a credential can be reported as
    // on any client, since no client can read one back) and the connection
    // phase, which is the state the row's own "Needs approval" badge is drawn
    // from.
    //
    // What this replaced said "No saved credentials, you will be asked to sign
    // in", and both halves of that were claims rather than observations. A
    // gateway that needs no credential never asks, so the sentence promised a
    // sign-in that would not happen, and "no saved credentials" read as a
    // verdict on this app's storage rather than on this connection. The state
    // itself is what is left, and it is the same words on every client because
    // it is the same state on every client. Where a credential is kept, and in
    // what, is each client's own business and not this line's: the desktop
    // keeps it in an encrypted file and the phone in the Keychain, which is a
    // fact about the two implementations rather than about this gateway.
    const facts = [creds.hasToken ? 'Token saved' : 'No token saved'];
    if (creds.hasPassword) facts.push('Password saved');
    if (creds.headers.length) facts.push(`${creds.headers.length} header${creds.headers.length > 1 ? 's' : ''} saved`);
    const approval = deviceApproval(gw);
    if (approval === 'approved') facts.push('Device approved');
    else if (approval === 'pending') facts.push('Device needs approval');

    // What this gateway is doing, and why it is not doing it. The badge used to
    // say "Connected" for whichever gateway was *selected*, which was a lie for
    // the entire time a connection was failing, the state in which someone is
    // most likely to be reading it.
    const status = gw.status || { tone: 'muted', label: 'Not connected', detail: null };

    // Upstream's row shape: a text column against a trailing control column, on
    // a group surface. The three groups are ours and they stay three: the text,
    // the connection state and the actions. What moved is WHERE the last two
    // live, into the control column that upstream gives every row, which is what
    // lets a narrow window put the state on a line of its own, centred, with the
    // buttons below it (the narrow-width rule in ui.css) without stretching the
    // state's pill across the card, which a full-width badge would do.
    const row = el('div', { className: 'settings-row' }, [
      el('div', { className: 'settings-row__text' }, [
        el('span', { className: 'settings-row__title', textContent: gw.label || gw.url }),
        el('span', { className: 'url', textContent: gw.url }),
        el('span', { className: 'settings-row__desc', textContent: facts.join(' · ') }),
        status.detail ? el('span', { className: `result ${status.tone}`, textContent: status.detail }) : null,
      ]),
      el('div', { className: 'settings-row__control' }, [
        el('div', { className: 'row__status' }, [
          el('span', { className: `badge badge--${status.tone}`, textContent: status.label }),
        ]),
        el('div', { className: 'row__actions' }, [
          el('button', {
            className: active ? 'ghost' : 'primary',
            // Pressing it again while it is already trying would tear down the
            // attempt in flight and start an identical one, which reads as the
            // button doing nothing.
            disabled: active && phase === 'connecting',
            textContent: (active && phase === 'connecting') ? 'Connecting…' : (active ? 'Reconnect' : 'Connect'),
            // The result arrives as a notice over the top of this page, rather than
            // by this page closing itself. See announceConnected() in src/main.js.
            onclick: () => { void call('connect', gw.id); },
          }),
          el('button', {
            className: 'ghost',
            textContent: open ? 'Done' : 'Edit',
            onclick: () => { editing = open ? null : gw.id; render(); },
          }),
          el('button', {
            className: 'ghost danger',
            textContent: 'Remove',
            onclick: async () => {
              if (editing === gw.id) editing = null;
              state = await call('removeGateway', gw.id);
              render();
            },
          }),
        ]),
      ]),
    ]);

    host.append(el('div', { className: 'settings-group' }, [row, open ? gatewayEditor(gw) : null]));
  }
}

/* ------------------------------------------------------------------- other */

/**
 * Certificates refused this session, waiting for a decision.
 *
 * This is the whole reason there is no certificate prompt any more. The
 * fingerprints are here to be compared rather than dismissed, nothing is
 * blocked on the answer, and doing nothing leaves the connection refused,
 * which is the safe outcome, unlike a modal whose easiest button is "yes".
 *
 * Desktop only, and the panel is hidden on a client without the tab, so this
 * renders nothing there whatever the state carries.
 */
function renderCertOffers() {
  const host = $('cert-offers');
  host.replaceChildren();
  const offers = state.certOffers || [];
  if (!offers.length) return;

  // Its own heading rather than the static one below, because this block sits
  // above Gateways and only exists while something is waiting.
  host.append(el('h2', { textContent: offers.length > 1 ? 'Certificates to review' : 'Certificate to review' }));

  for (const offer of offers) {
    const out = el('div', { className: 'result' });

    // A first sighting is routine on a :18789 address. A *changed* fingerprint
    // on a host that was trusted before is the case worth alarming about, and
    // the two must not look alike.
    const heading = offer.changed
      ? el('div', { className: 'result err', textContent: `The certificate for ${offer.host} has CHANGED since it was trusted.` })
      : el('div', { className: 'result warn', textContent: `${offer.host} is using a certificate this app cannot verify.` });

    const explain = el('span', {
      className: 'settings-row__desc',
      textContent: offer.changed
        ? 'Expected if the gateway was reinstalled or regenerated its certificate. If nothing like that happened, '
          + 'something is intercepting the connection, leave it refused.'
        : 'The OpenClaw gateway generates its own certificate, so this is normal when you connect straight to its '
          + 'listener (an address ending in :18789) instead of going through the Tailscale Serve address.',
    });

    const fingerprints = el('div', { className: 'settings-row__text' }, [
      offer.previous ? el('span', { className: 'url', textContent: `previously trusted  ${offer.previous}` }) : null,
      el('span', { className: 'url', textContent: `${offer.previous ? 'now presenting     ' : 'fingerprint  '}${offer.fingerprint}` }),
      offer.error ? el('span', { className: 'muted-sm', textContent: `Reason: ${offer.error}` }) : null,
    ]);

    const trust = el('button', {
      className: 'primary',
      textContent: offer.changed ? 'Trust the new certificate' : 'Trust this certificate',
      onclick: async () => {
        const res = await call('trustCert', offer.host);
        state = res;
        setResult(out, res.trusted ? `Pinned. Reconnecting to ${offer.host}…` : 'That certificate is no longer being offered.', res.trusted ? 'ok' : 'warn');
        render();
      },
    });

    const dismiss = el('button', {
      className: 'ghost',
      textContent: 'Not now',
      onclick: async () => { state = await call('dismissCertOffer', offer.host); render(); },
    });

    host.append(el('div', { className: 'settings-group' }, [
      heading,
      // One stacked row for the two halves of the explanation: the control that
      // decides this is the pair of buttons, so the reading matter belongs in the
      // row that carries it rather than loose in the group.
      el('div', { className: 'settings-row settings-row--stacked' }, [explain, fingerprints]),
      explain,
      fingerprints,
      el('div', { className: 'settings-row settings-row--actions' }, [
        el('div', { className: 'settings-row__control' }, [dismiss, trust]),
      ]),
      out,
    ]));
  }
}

/* ------------------------------------------------------------ what happened */

// Rows shown on the page. The files hold three months, which is a thing to grep
// rather than scroll, so the page shows the recent ones and offers the folder
// for the rest. Without a cap, one bad night puts hundreds of rows under the
// preferences and buries them.
const HISTORY_SHOWN = 20;

/** A timestamp as a person reads it, in their own locale and zone. */
function when(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/**
 * How long it went on, in the largest unit that is still honest.
 *
 * A null end is not a missing value: it means the raise was never answered by a
 * clear, so as far as the record goes the condition is still true. Saying so is
 * the point, since an open failure is the one worth looking at.
 */
function lasted(from, to) {
  if (!to) return 'still happening';
  const ms = Date.parse(to) - Date.parse(from);
  if (!Number.isFinite(ms) || ms < 0) return '';
  // Tested against the duration, not the rounded minutes: rounding 40 seconds
  // gives 1, which walks straight past a `mins < 1` guard and reports a blip as
  // a minute-long outage.
  if (ms < 60000) return 'lasted under a minute';
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `lasted ${mins} min`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `lasted ${hours} h`;
  return `lasted ${Math.round(hours / 24)} days`;
}

function renderNoticeHistory() {
  const host = $('notice-history');
  if (!host) return;
  host.replaceChildren();

  if (history === null) return; // not read yet; an empty card would be a lie
  if (!history.length) {
    host.append(el('div', { className: 'settings-group empty', textContent: 'Nothing has gone wrong that the app noticed.' }));
    return;
  }

  for (const row of history.slice(0, HISTORY_SHOWN)) {
    host.append(el('div', { className: 'settings-group' }, el('div', { className: 'settings-row' }, [
      el('div', { className: 'settings-row__text' }, [
        el('span', { className: 'settings-row__title', textContent: row.message }),
        row.detail ? el('span', { className: 'url', textContent: row.detail }) : null,
        el('span', { className: 'settings-row__desc', textContent: [when(row.from), lasted(row.from, row.to)].filter(Boolean).join(' · ') }),
      ]),
      el('div', { className: 'settings-row__control' }, [
        el('span', {
          className: `badge badge--${row.tone === 'error' ? 'err' : 'warn'}`,
          textContent: row.tone === 'error' ? 'Error' : 'Warning',
        }),
      ]),
    ])));
  }

  host.append(el('div', { className: 'settings-row settings-row--actions' }, [
    el('div', { className: 'settings-row__control' }, [
      el('span', {
        className: 'muted-sm',
        textContent: history.length > HISTORY_SHOWN
          ? `Showing the ${HISTORY_SHOWN} most recent of ${history.length} kept.`
          : 'Kept for three months, a file per month.',
      }),
      el('button', { className: 'ghost', textContent: 'Open log folder', onclick: () => call('openNoticeLog') }),
    ]),
  ]));
}

/** Read the log and redraw. Failure leaves the section empty rather than the page broken. */
async function loadHistory() {
  if (!hasCommand('noticeHistory')) return;
  try { history = await call('noticeHistory'); } catch { history = []; }
  renderNoticeHistory();
}

function renderCerts() {
  const host = $('certs');
  host.replaceChildren();
  const hosts = Object.keys(state.trustedCerts || {});

  if (!hosts.length) {
    host.append(el('div', { className: 'settings-group empty', textContent: 'No certificates have been pinned.' }));
    return;
  }

  for (const name of hosts) {
    host.append(el('div', { className: 'settings-group' }, el('div', { className: 'settings-row' }, [
      el('div', { className: 'settings-row__text' }, [
        el('span', { className: 'settings-row__title', textContent: name }),
        el('span', { className: 'url', textContent: state.trustedCerts[name] }),
      ]),
      el('div', { className: 'settings-row__control' }, [
        el('button', {
          className: 'ghost danger',
          textContent: 'Forget',
          onclick: async () => { state = await call('forgetCert', name); render(); },
        }),
      ]),
    ])));
  }
}

function renderPrefs() {
  const s = state.settings || {};
  // Each row is written only if this client has it. A control that is not on
  // screen must not be written from, and one that is on screen must not be
  // skipped: that reading of the split is the whole reason the ids are checked
  // here rather than the DOM being assumed complete.
  if (hasSetting('appearance')) $('appearance').value = (state.appearance && state.appearance.mode) || 'system';
  if (hasSetting('closeToTray')) $('closeToTray').checked = Boolean(s.closeToTray);
  if (hasSetting('launchAtLogin')) $('launchAtLogin').checked = Boolean(s.launchAtLogin);
  if (hasSetting('startHidden')) $('startHidden').checked = Boolean(s.startHidden);
  if (hasSetting('promptMetadata')) $('promptMetadata').checked = Boolean(s.promptMetadata);
  if (hasSetting('globalShortcut')) $('globalShortcut').value = s.globalShortcut || '';

  if (!hasSetting('autoUpdate')) return;
  // A build that could never install an update has nothing to switch on, so the
  // checkbox says why instead of sitting there doing nothing when clicked,
  // which is what an unsigned macOS build or a non-AppImage Linux run gets.
  const canInstall = !state.updates || state.updates.canInstall;
  $('autoUpdate').checked = s.autoUpdate && canInstall;
  $('autoUpdate').disabled = !canInstall;
  if (!canInstall) {
    $('autoUpdate-hint').textContent =
      `This build cannot install its own updates, ${state.updates.reason}. It will still tell you when a new version exists.`;
  }
}

// The "looking for the gateway's own settings?" card, under every tab.
//
// It sits with the About footer, outside every panel, so it is on screen
// whichever tab is showing. It used to live inside the Gateways panel, on the
// reasoning that the person it is for has the gateways tab open, and that is the
// half that was wrong: someone who opened Settings looking for the gateway's own
// settings can be on any tab when they realise it, and behind Certificates the
// card was on a page they could not see. One card, not one per tab: this is the
// single copy in the document and the tests assert it.
//
// Shown only when there is a Control UI behind this to reach: a gateway is
// configured (so this is not a first run) and the client can take the reader
// there (`openControlUiSettings`, which both clients answer). On a first run
// there is no page behind these settings, so the card would point at nothing
// and stays hidden. The action itself is wired once in the listeners below.
//
// The command is `openControlUiSettings` rather than `closeSettings`, and that
// distinction is the whole point of the card: closing this surface lands the
// reader on whatever the Control UI was showing, which is not what the card
// promises. Taking them there is one command on the host (close this surface,
// then press the Control UI's own footer control) and it is the same command on
// both clients.
function renderControlUiSettingsLink() {
  const card = $('control-ui-settings');
  if (!card) return;
  card.hidden = firstRun || !hasCommand('openControlUiSettings');
}

// The About footer, under every tab. Shown when this client's host answers
// `openAbout`, hidden otherwise, exactly like the Control-UI card above: a
// button that reaches a command the host does not implement is a button that
// does nothing, so it is the command's presence that decides whether the footer
// appears. Not gated on firstRun: the About page answers "which build is this?"
// during setup as much as after it, which is why the footer sits outside #prefs.
//
// This replaced a raw build string printed here (app, build, runtime and the
// config path, all on one line). None of that detail is lost: it lives in the
// About page now, one click behind this footer. See core/ui/about.html and each
// host's aboutState().
function renderAboutFooter() {
  const footer = $('about-footer');
  if (!footer) return;
  footer.hidden = !hasCommand('openAbout');
  // The build beside the name, from the state the host already sends: the
  // footer's job is to be findable, and "which build is this" is the question
  // that makes someone go looking for it. Absent rather than invented when the
  // host has nothing to say.
  const build = $('about-footer-build');
  if (build) build.textContent = (state && state.build) ? state.build : '';
}

/* ---------------------------------------------------------------- the tabs */

// The tabs this page's own markup provides, in document order, read off the
// buttons rather than listed a second time. Which of them this client has comes
// from the spec; this is only what is in the document.
const ALL_TAB_IDS = [...document.querySelectorAll('#tabs .tab')].map((b) => b.id.replace(/^tab-/, ''));

// A first run has nothing to prefer and nothing has gone wrong yet, so those two
// tabs lead nowhere. Certificates stays, because refusing a gateway's own
// certificate is often the very first thing that happens.
const FIRST_RUN_TABS = ['gateways', 'certificates'];

/** The tabs that exist right now, in this client. Arrow keys walk these. */
function visibleTabs() {
  const mine = surfaceTabIds();
  return FIRST_RUN_TABS.filter((t) => mine.includes(t)).length && firstRun
    ? FIRST_RUN_TABS.filter((t) => mine.includes(t))
    : mine;
}

// The subtitle describes the tab, not the page. One fixed line under a tab bar
// is wrong on three of the four tabs, and a heading that is wrong is worse than
// no heading. The words live here rather than in the spec because this page
// cannot read the spec's file, and a string in two places that can only import
// one of them is how a page ends up disagreeing with its own list.
const SUBTITLES = {
  gateways: 'Choose which gateway this app connects to.',
  behaviour: 'How the app starts, updates, and stays out of the way.',
  certificates: 'Certificates you have chosen to trust for a host.',
  problems: 'What went wrong, kept for three months.',
};

let tab = ALL_TAB_IDS[0];

/**
 * Play a panel's arrival, once.
 *
 * The class has to come off and go back on with a layout read in between, or a
 * panel arriving a second time runs nothing: the browser sees the class it already
 * applied and the animation does not restart. The read is the `offsetWidth`, which
 * forces the style to be computed before the class goes back on.
 */
function replayPanelIn(panel, toward) {
  panel.classList.remove('panel--in-from-left', 'panel--in-from-right');
  void panel.offsetWidth;
  panel.classList.add(`panel--in-from-${toward}`);
}

/**
 * Show one panel and hide the rest.
 *
 * The scroll reset matters: panels differ in length, so switching from a long
 * one to a short one otherwise lands you scrolled past the whole of it, looking
 * at blank space and concluding the tab is empty.
 *
 * The incoming panel animates in from the side the reader moved TOWARD, so the
 * motion points the way they went, and only the incoming one: the outgoing panel
 * is hidden on the same line, because two panels on screen at once is a view the
 * reader did not ask for to look at a view they did. See ui/CONVENTIONS.md.
 */
function showTab(name) {
  if (!visibleTabs().includes(name)) return;
  const previous = tab;
  tab = name;
  const to = ALL_TAB_IDS.indexOf(name);
  const from = ALL_TAB_IDS.indexOf(previous);
  // No direction when the tab did not change, and none on the first call: the
  // first panel arrives with the surface, which animates as a whole.
  const toward = to === from ? null : (to > from ? 'right' : 'left');
  for (const t of ALL_TAB_IDS) {
    const on = t === name;
    const button = $(`tab-${t}`);
    const panel = $(`panel-${t}`);
    if (button) {
      button.hidden = !visibleTabs().includes(t);
      button.setAttribute('aria-selected', String(on));
      // Roving tabindex: the tab bar is one stop in the page's tab order, and
      // the arrow keys move within it. Leaving every tab focusable makes Tab
      // walk all four before reaching the panel they control.
      button.tabIndex = on ? 0 : -1;
    }
    // A panel this client does not have stays hidden whatever is asked for. The
    // guard at the top covers the tab the spec gave us; this covers the panel
    // that goes with a tab we did not.
    if (panel) {
      const shown = on && surfaceTabIds().includes(t);
      panel.hidden = !shown;
      if (shown && toward) replayPanelIn(panel, toward);
    }
  }
  const body = document.querySelector('.modal__body');
  if (body) body.scrollTop = 0;
  renderHeading();
}

/** How many conditions are true right now, shown on the tab that lists them. */
async function refreshProblemCount() {
  const badge = $('tab-problems-count');
  if (!badge) return;
  if (!hasCommand('liveNotices')) return;
  let live = [];
  // liveNotices, not notices: the latter is the banner's unread list, and a
  // failure you have read is still a failure. A count that emptied when you
  // closed the bar would say the app was fine because you stopped looking.
  try { live = await call('liveNotices'); } catch { live = []; }
  // Live conditions rather than the log's unresolved rows: a failure the app was
  // killed during never got its clear written, so the log would call it open
  // forever.
  const active = live.filter((n) => n.tone === 'error' || n.tone === 'warn').length;
  badge.textContent = String(active);
  badge.hidden = active === 0;
}

/**
 * The heading.
 *
 * It used to carry the reason this page was on screen, because a failure put it
 * there and it owed an explanation for having taken over the window. Nothing
 * does that any more, a failure raises a notice and leaves the window alone,
 * so the page is only ever here because someone opened it, and it says which
 * part of itself you are looking at.
 */
function renderHeading() {
  if (firstRun) return;
  $('title').textContent = 'Settings';
  $('subtitle').textContent = SUBTITLES[tab] || SUBTITLES.gateways;
}

function render() {
  renderHeading();
  renderControlUiSettingsLink();
  renderAboutFooter();
  renderGateways();
  // Certificates renders on a first run too: its panel is reachable then, and a
  // refused certificate is one of the likeliest things to happen during setup.
  renderCertOffers();
  renderCerts();
  if (!firstRun) { renderPrefs(); renderNoticeHistory(); }
}

function setResult(node, text, kind) {
  if (!node) return;
  node.textContent = text;
  node.className = `result${kind ? ` ${kind}` : ''}`;
}

/* --------------------------------------------------------------- listeners */

// Takes the reader to the Control UI's own settings, which is where the
// gateway's agents, models and channels live. One command, and the HOST owns
// both halves of it: it closes this surface and then presses the Control UI's
// own footer control, which is the route the Control UI already has. Nothing
// here navigates the Control UI or builds a URL for it, so this page cannot
// disagree with the Control UI about where its settings are.
//
// Guarded so a client without the command does not throw; the card that carries
// this button is hidden in the same case.
const openControlUiSettings = $('open-control-ui-settings');
if (openControlUiSettings) {
  openControlUiSettings.addEventListener('click', () => {
    if (hasCommand('openControlUiSettings')) call('openControlUiSettings');
  });
}

// Opens the shared About page over this surface. Reaches the app through the
// same host door every other action here uses, so the desktop and the phone
// each answer it their own way (an overlay, a sheet) behind one command name.
// Guarded so a client without the command does not throw; the footer is hidden
// in the same case.
const openAbout = $('open-about');
if (openAbout) {
  openAbout.addEventListener('click', () => {
    if (hasCommand('openAbout')) call('openAbout');
  });
}

/* --------------------------------------------------------------- add form */

/**
 * The add form, built from the SAME field set the editor renders.
 *
 * Built here rather than written out in the markup, because a second copy of
 * these rows is exactly how the two came to offer different things: the markup
 * took a name and an address, so a gateway created from it had no token and had
 * to be found again and reopened to get one. One builder called twice is the fix.
 *
 * Built ONCE, at boot, rather than on every render: a form rebuilt under a
 * keyboard mid-typing throws away whatever was typed into it, which is the same
 * fault as a field that never saves.
 *
 * The actions say what they do. It is "Add gateway" rather than "Add", and the
 * row above the fields says when the values are kept and that nothing is
 * contacted until Connect, which is the half of this form a reader had to guess.
 */
function renderAddForm() {
  const host = $('add-gateway');
  if (!host) return;
  host.replaceChildren();

  const out = el('div', { className: 'result', id: 'test-result' });
  const fields = gatewayFields({}, {
    mode: 'new',
    out,
    // The element names this form has always had, kept because the harnesses that
    // drive it look for them. What the form OFFERS is the part that changed.
    ids: {
      label: 'new-label',
      url: 'new-url',
      token: 'new-token',
      password: 'new-password',
      headerName: 'new-header-name',
      headerValue: 'new-header-value',
    },
  });

  const test = el('button', {
    id: 'test',
    textContent: 'Test connection',
    onclick: async () => {
      const address = fields.url.value.trim();
      if (!address) return setResult(out, 'Enter an address first.', 'err');
      test.disabled = true;
      setResult(out, 'Testing…');
      const res = await call('testGateway', address);
      test.disabled = false;
      setResult(out, res.message, res.ok ? (res.fingerprint ? 'warn' : 'ok') : 'err');
    },
  });

  const add = el('button', {
    id: 'add',
    className: 'primary',
    textContent: 'Add gateway',
    onclick: () => saveNewGateway(fields, out),
  });

  host.append(
    // The heading is a row of its own rather than the Name field's label, which
    // is what it used to be: the section had no name and the name field had two.
    el('div', { className: 'settings-row settings-row--stacked' }, el('div', { className: 'settings-row__text' }, [
      el('span', { className: 'settings-row__title', textContent: 'Add a gateway' }),
      el('span', {
        className: 'settings-row__desc',
        textContent: 'Everything here is kept together, the token included. Nothing is contacted until you press Connect on the row it adds.',
      }),
    ])),
    fields.node,
    el('div', { className: 'settings-row settings-row--actions' }, el('div', { className: 'settings-row__control' }, [test, add])),
    out,
  );
}

/**
 * Create a gateway and keep everything typed into its form, in ONE pass.
 *
 * The form used to take a name and an address and then answer "Added. Use Edit to
 * save its token, password, or headers", so the gateway existed half-configured
 * and finishing it was a second trip. A credential is stored against a gateway's
 * id, so the order is the store's rather than a choice: the gateway is created
 * first and the credential goes in immediately after, through the SAME command
 * the editor uses and into the same place. What the reader sees is one press.
 *
 * The report names what was kept rather than saying "Added": a save that quietly
 * dropped the token would read exactly like one that stored it, and a refusal from
 * the credential store is the one answer that has to be visible.
 */
async function saveNewGateway(fields, out) {
  const url = fields.url.value.trim();
  const label = fields.name.value.trim();
  if (!url) return setResult(out, 'Enter an address first.', 'err');

  const res = await call('addGateway', { label, url });
  state = res;
  // A host that refuses the address answers in `saved`, the same shape the
  // credential command uses, and there is then no id to attach a credential to.
  // Reporting this as an add is what used to happen on a phone given an address
  // it cannot parse: the page said "Added" over the top of a refusal.
  if (!res.added) {
    setResult(out, res.saved && res.saved.error ? res.saved.error : 'That gateway was not added.', 'err');
    render();
    return;
  }

  const id = res.added.id;
  const creds = {};
  if (fields.token.value) creds.token = fields.token.value;
  if (fields.password.value) creds.password = fields.password.value;
  const headerNamed = Boolean(fields.headerName && fields.headerName.value.trim());

  const problems = [];
  if (Object.keys(creds).length) {
    const saved = await call('setCredentials', id, creds);
    state = saved;
    if (!saved.saved.ok) problems.push(saved.saved.error);
  }
  if (headerNamed) {
    const saved = await call('addHeader', id, fields.headerName.value, fields.headerValue.value);
    state = saved;
    if (!saved.saved.ok) problems.push(saved.saved.error);
  }

  const kept = [];
  if (label) kept.push('name');
  kept.push('address');
  if (creds.token) kept.push('token');
  if (creds.password) kept.push('password');
  if (headerNamed) kept.push('header');

  // Emptied only once the values are stored, so a refusal leaves them on screen
  // to be corrected rather than making the reader type them again.
  for (const control of [fields.name, fields.url, fields.token, fields.password, fields.headerName, fields.headerValue]) {
    if (control) control.value = '';
  }

  setResult(
    out,
    problems.length
      ? `Added, but ${problems.join(', and ')}`
      : `Added. Kept its ${listWords(kept)}, and it connects from its own row.`,
    problems.length ? 'warn' : 'ok',
  );
  render();
}

/** One readable list: "address and token", "name, address and token". */
function listWords(words) {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

/* ---------------------------------------------------------------- gateway filter */

const gatewayFilter = $('gatewayFilter');
const clearFilter = $('clearFilter');
if (gatewayFilter) {
  // Seed from the in-memory value (always empty on normal entry, but keeps
  // renderGateways consistent even if we later add URL param support).
  gatewayFilter.value = gatewayFilterText;

  gatewayFilter.addEventListener('input', () => {
    gatewayFilterText = gatewayFilter.value;
    renderGateways();
  });

  if (clearFilter) {
    clearFilter.addEventListener('click', () => {
      gatewayFilterText = '';
      gatewayFilter.value = '';
      renderGateways();
      gatewayFilter.focus();
    });
  }
}

$('save').addEventListener('click', async () => {
  // Only what this client has. A key written from a client that does not show it
  // would be a preference changed by a control nobody touched, and a key left out
  // on a client that does show it would be a preference that silently never
  // saves.
  const patch = {};
  if (hasSetting('appearance')) patch.appearance = $('appearance').value;
  if (hasSetting('closeToTray')) patch.closeToTray = $('closeToTray').checked;
  if (hasSetting('launchAtLogin')) patch.launchAtLogin = $('launchAtLogin').checked;
  if (hasSetting('startHidden')) patch.startHidden = $('startHidden').checked;
  if (hasSetting('promptMetadata')) patch.promptMetadata = $('promptMetadata').checked;
  // Never write false just because the checkbox is disabled: a Linux user who
  // once ran the unpacked binary would come back to their AppImage with the
  // preference silently turned off.
  if (hasSetting('autoUpdate') && !$('autoUpdate').disabled) patch.autoUpdate = $('autoUpdate').checked;
  if (hasSetting('globalShortcut')) patch.globalShortcut = $('globalShortcut').value.trim();

  const res = await call('saveSettings', patch);
  state = res;

  // The two things a save can fail at are desktop's, because the settings they
  // belong to are. A client without them gets neither field back, so both are
  // read as absent rather than assumed.
  const problems = [
    !res.shortcut || res.shortcut.ok ? null : `the shortcut was rejected (${res.shortcut.error})`,
    !res.login || res.login.ok ? null : `"open at login" could not be set (${res.login.error})`,
  ].filter(Boolean);

  setResult(
    $('save-result'),
    problems.length ? `Saved, but ${problems.join(', and ')}.` : 'Saved.',
    problems.length ? 'warn' : 'ok',
  );
  render();
});

/* ------------------------------------------------------------------ appearance */

// Applied on the spot rather than at Save, unlike every other row on this tab.
// The others are preferences whose effect is somewhere else and later; this one
// repaints the app the moment it is chosen, so sending it with a button press
// nobody has made yet would leave the screen showing the old colours and the
// control describing new ones. The host answers with the state it produced, so
// the select is written from what the client actually did rather than from what
// was asked for.
const appearance = $('appearance');
if (appearance) {
  appearance.addEventListener('change', async () => {
    const out = $('appearance-result');
    const res = await call('saveSettings', { appearance: appearance.value });
    state = res;
    const mode = (state.appearance && state.appearance.mode) || 'system';
    appearance.value = mode;
    setResult(out, 'Appearance set to ' + appearance.options[appearance.selectedIndex].textContent.toLowerCase() + '.', 'ok');
  });
}

/* ----------------------------------------------------------------- dismiss */

// Only dismissable as a modal. When this page IS the window, a first run on the
// desktop or any time on iOS, there is nothing behind it to go back to, and an
// Escape key that emptied the window would leave the app running with a blank
// frame and no way to pick a gateway. On iOS the sheet's own pull-down is the
// way out, which is why the page does not draw a second one.
if (!asPage) {
  const dismiss = () => call('closeSettings');
  $('close').addEventListener('click', dismiss);
  // Only a click that both starts and ends on the scrim counts. Without the
  // target check, releasing the mouse outside the card after selecting text
  // inside it closes the dialog and throws away what you were doing.
  $('scrim').addEventListener('mousedown', (e) => {
    if (e.target !== e.currentTarget) return;
    const up = (ev) => { if (ev.target === e.currentTarget) dismiss(); };
    $('scrim').addEventListener('mouseup', up, { once: true });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') dismiss();
  });
}

// The tab bar is wired for every client, and deliberately outside the block
// above. It used to be inside it, which meant the tabs did nothing whenever this
// page was the window rather than a dialog in one, and that is the only mode a
// first run has: on a first run the whole point of the tab bar is the
// Certificates tab, and it could not be opened. Found while giving the page a
// second client, where it is always in this mode.
//
// Left and right move between tabs, Home and End jump to the ends, which is
// what a tablist is expected to do and the reason the tabs carry a roving
// tabindex rather than all being in the page's tab order.
$('tabs').addEventListener('click', (e) => {
  const button = e.target.closest('.tab');
  if (button) showTab(button.id.replace(/^tab-/, ''));
});
$('tabs').addEventListener('keydown', (e) => {
  const walk = visibleTabs();
  const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
  let next = null;
  if (step) next = walk[(walk.indexOf(tab) + step + walk.length) % walk.length];
  else if (e.key === 'Home') next = walk[0];
  else if (e.key === 'End') next = walk[walk.length - 1];
  if (!next) return;
  e.preventDefault();
  showTab(next);
  $(`tab-${next}`).focus();
});

/* -------------------------------------------------------------------- boot */

// A certificate refused while this page is open, which is exactly what
// pressing Reconnect from in here does, has to appear without the page being
// closed and reopened. The snapshot this renders from is otherwise as old as
// the sheet.
on('state', async () => {
  state = await call('state');
  applySurface();
  render();
});

(async () => {
  state = await call('state');
  if (firstRun) {
    $('title').textContent = 'Connect to a gateway';
    $('subtitle').textContent = 'Pick the OpenClaw gateway this app should open, or add your own.';
  }
  // Preferences are hidden only on a first run, where there is nothing to
  // prefer yet. A failed connection shows the whole page: the setting that
  // needs changing to fix it could be any of them.
  $('prefs').hidden = firstRun;
  // The bar stays on a first run, showing the two tabs that mean anything then.
  // showTab hides the buttons for the rest.
  $('close').hidden = asPage;
  // What this client has, before anything is drawn: the spec's split decides
  // both the rows and which of them the first render is allowed to touch.
  applySurface();
  // The add form, from the field set this client has: it is built here because
  // which fields exist is the spec's answer, and only once because a form rebuilt
  // under a keyboard would lose what is being typed into it.
  renderAddForm();
  // A notice can name the tab that answers it, so "Review" on a refused
  // certificate lands on the fingerprints rather than on Gateways with the work
  // of finding them left to you. The URL carries it on the desktop; the host
  // carries it on iOS, for the reason `asPage` above explains.
  const wanted = params.get('tab') || host.tab;
  showTab(visibleTabs().includes(wanted) ? wanted : visibleTabs()[0]);
  render();
  // After the first paint rather than before it: the page is useful without the
  // log, and reading three months of files should not hold up the card.
  if (!firstRun) { loadHistory(); refreshProblemCount(); }
})();

// A notice going up or coming down is exactly when the log gained a line, so the
// section is re-read then rather than polled. Open Settings, watch a gateway
// fail, and the row appears underneath without reopening the page.
on('notices', () => { if (!firstRun) { loadHistory(); refreshProblemCount(); } });
