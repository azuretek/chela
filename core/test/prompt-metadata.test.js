// The parts of the prompt block that a fixture cannot carry.
//
// The golden pairs in core/fixtures/prompt-metadata.json are asserted in
// fixtures.test.js and again by the Swift port. What is left is the shape a
// fixture cannot express: that the block is a single strippable unit, that the
// injected script is ONE file rather than one copy per client, that the script's
// own inline rules agree with the pure ones above it, and that installing twice
// updates the configuration instead of stacking a second send hook.

import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  CONTEXT_MARKER, CLOSING, FRAMING, MAX_VALUE_LENGTH, clean, clientScript, contextHeader, formatBlock,
  hookSource, inject, shouldInject, transformFrame,
} from '../prompt-metadata.js';

/*
 * A local model of the gateway's stripInboundMetadata, so this test proves the
 * contract the framing is most likely to break without depending on the gateway
 * source: a block is a header line ENDING with the marker, and everything from
 * that header down to (and including) the first blank line is removed from what
 * a person reads. The framing must live inside that run, which is exactly what
 * this asserts.
 */
function stripInboundMetadata(text) {
  const lines = text.split('\n');
  const out = [];
  let i = 0;
  while (i < lines.length) {
    if (lines[i].endsWith(CONTEXT_MARKER) && lines[i].length > CONTEXT_MARKER.length) {
      // Drop the header and every line until the first blank line, inclusive.
      i += 1;
      while (i < lines.length && lines[i].trim() !== '') i += 1;
      if (i < lines.length) i += 1; // consume the blank separator too
      continue;
    }
    out.push(lines[i]);
    i += 1;
  }
  return out.join('\n');
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, '..', '..');
const FIXTURES = path.join(REPO, 'core', 'fixtures');

const fixture = JSON.parse(
  fs.readFileSync(path.join(FIXTURES, 'prompt-metadata.json'), 'utf8'),
);

const DESKTOP_HEADER = contextHeader('desktop');
const MOBILE_HEADER = contextHeader('mobile');

function hookedSocket(config) {
  class FakeWebSocket {
    send(data) { this.sent = data; }
  }
  const context = { window: {}, WebSocket: FakeWebSocket };
  vm.runInNewContext(clientScript(config), context);
  return new FakeWebSocket();
}

function sentMessage(socket, message) {
  const frame = JSON.stringify({ method: 'chat.send', params: { message } });
  socket.send(frame);
  if (socket.sent === frame) return message;
  return JSON.parse(socket.sent).params.message;
}

/* --------------------------------------------------------- the strip contract */

test('the header ends with the marker, which is what makes the gateway strip it', () => {
  for (const header of [DESKTOP_HEADER, MOBILE_HEADER]) {
    assert.ok(header.endsWith(CONTEXT_MARKER), 'the stripper only matches a header ENDING in the marker');
    assert.ok(header.length > CONTEXT_MARKER.length, 'a bare marker line is not a header');
  }
});

test('the marker and the configuration global are the pinned ones', () => {
  assert.strictEqual(CONTEXT_MARKER, fixture.marker);
  assert.ok(hookSource().includes(`window.${fixture.global}`), 'the hook reads the configured global');
  assert.ok(contextHeader().startsWith('Desktop'), 'the desktop header is unchanged by this refactor');
});

test('a value cannot forge a second header or close the block early', () => {
  const block = formatBlock({
    host: `evil ${CONTEXT_MARKER}`, os: '<script>', user: 'u', home: 'h', locale: 'l', timezone: 't', client: 'c',
  });
  const lines = block.split('\n');
  assert.strictEqual(lines.filter((line) => line.includes(CONTEXT_MARKER)).length, 1);
  // The header, then the framing lines, then the fields, then the closing. The
  // value lines are what a malicious value could corrupt, so they are what this
  // checks, with the closing lines sliced back off the end.
  const fieldLines = lines.slice(1 + FRAMING.length, lines.length - CLOSING.length);
  assert.deepStrictEqual(
    fieldLines.map((line) => line.split(':')[0]),
    ['host', 'os', 'user', 'home', 'locale', 'timezone', 'client'],
  );
  for (const line of fieldLines) {
    assert.ok(line.length < MAX_VALUE_LENGTH + 32, `unbounded line: ${line}`);
  }
});

test('the prompt is separated from the block by the blank line the stripper needs', () => {
  const block = formatBlock({ host: 'example-host' });
  assert.strictEqual(inject('hello', block), `${block}\n\nhello`);
});

test('the closing line ends the block, after the fields and before the blank line', () => {
  assert.ok(CLOSING.length >= 1, 'expected a closing line that marks the end of the context');
  const block = formatBlock({ host: 'example-host', os: 'macOS 26.6.2 (arm64)' });
  const lines = block.split('\n');
  // The closing lines are the LAST lines of the block: header, framing, fields,
  // then closing. They must never end with the marker (that would forge a
  // second header) or be blank (that would end the block early, and everything
  // after it, the closing line included, would leak to the user).
  const tail = lines.slice(lines.length - CLOSING.length);
  assert.deepStrictEqual(tail, CLOSING, 'the closing lines are the last lines in the block');
  for (const line of CLOSING) {
    assert.ok(line.trim() !== '', 'a blank closing line would end the block early');
    assert.ok(!line.endsWith(CONTEXT_MARKER), 'a closing line must not read as a header');
  }
  // A field comes before the closing, so the closing genuinely follows the
  // context rather than replacing it.
  assert.ok(lines[lines.length - CLOSING.length - 1].includes(': '), 'the closing follows the fields');
});

test('the closing line is inside the block, so injecting keeps it before the blank line', () => {
  // This is the failure this ordering exists to avoid: a boundary marker placed
  // AFTER the blank line would be part of the visible user message. The block
  // ends with the closing, inject() then adds the blank line and the words, so
  // every closing line sits strictly before the first blank line.
  const block = formatBlock({ host: 'example-host' });
  const sent = inject('hello', block);
  const blankAt = sent.indexOf('\n\n');
  assert.ok(blankAt > 0, 'the block and the message are separated by a blank line');
  const beforeBlank = sent.slice(0, blankAt);
  const afterBlank = sent.slice(blankAt + 2);
  for (const line of CLOSING) {
    assert.ok(beforeBlank.includes(line), 'the closing line is inside the block, before the blank line');
    assert.ok(!afterBlank.includes(line), 'no closing line leaks into the visible message');
  }
  assert.strictEqual(afterBlank, 'hello', 'the visible portion is the user message alone');
});

test('the framing is present, one bounded line per entry, inside the block', () => {
  assert.ok(FRAMING.length >= 1, 'expected framing lines that tell the model what the block is');
  const block = formatBlock({ host: 'example-host' });
  const lines = block.split('\n');
  // The header is first, then every framing line, then the fields. No framing
  // line may end with the marker (that would forge a second header) or be blank
  // (that would end the block early and leak the fields to the user).
  assert.strictEqual(lines[0], contextHeader('desktop'));
  for (let i = 0; i < FRAMING.length; i += 1) {
    assert.strictEqual(lines[1 + i], FRAMING[i], 'framing sits between the header and the fields');
    assert.ok(FRAMING[i].trim() !== '', 'a blank framing line would end the block early');
    assert.ok(!FRAMING[i].endsWith(CONTEXT_MARKER), 'a framing line must not read as a header');
  }
  assert.ok(lines[1 + FRAMING.length].startsWith('host:'), 'the fields follow the framing');
});

test('the block, framing and all, is still stripped from what the user reads', () => {
  const block = formatBlock({
    host: 'example-host', os: 'macOS 26.6.2 (arm64)', user: 'example-user',
    home: '/home/example-user', locale: 'en-US', timezone: 'Europe/London',
    client: 'Claw Control UI (claw-desktop) 1.0.1',
  });
  const sent = inject('what time is it?', block);

  // The framing is really there before we strip, or this test proves nothing.
  for (const line of FRAMING) assert.ok(sent.includes(line), 'framing should be in the sent prompt');

  // The closing line is really there before we strip, or the leak check below
  // proves nothing.
  for (const line of CLOSING) assert.ok(sent.includes(line), 'the closing line should be in the sent prompt');

  const visible = stripInboundMetadata(sent);
  assert.strictEqual(visible, 'what time is it?', 'the whole block, framing and closing included, is stripped');
  assert.ok(!visible.includes(CONTEXT_MARKER), 'no marker survives to the user');
  for (const line of FRAMING) {
    assert.ok(!visible.includes(line), 'no framing line survives to the user');
  }
  for (const line of CLOSING) {
    assert.ok(!visible.includes(line), 'no closing line survives to the user');
  }
  // The exact failure mode this shape guards against: nothing of the separator,
  // not even a fragment of it, is left in what the user reads.
  assert.ok(!visible.includes('end of client context'), 'the boundary marker does not leak into the message');
  assert.ok(!visible.includes('-----'), 'no rule characters from the boundary leak into the message');
});

test('the mobile block, framing and all, is stripped too', () => {
  const block = formatBlock({ host: 'iPhone', os: 'iOS 26.0 (iPhone17,1)' }, 'mobile');
  const visible = stripInboundMetadata(inject('hello', block));
  assert.strictEqual(visible, 'hello');
});

test('the model receives the block plus closing on the active turn, at frame level', () => {
  // The gateway strips the block from what a PERSON reads and from replayed
  // past turns, but the active turn keeps its metadata, so this proves the
  // model still sees the whole unit, closing line included, in the outbound
  // chat.send frame the client actually sends.
  const block = formatBlock({
    host: 'example-host', os: 'macOS 26.6.2 (arm64)', user: 'example-user',
    home: '/home/example-user', locale: 'en-US', timezone: 'Europe/London',
    client: 'Claw Control UI (claw-desktop) 1.0.1',
  });
  const socket = hookedSocket({ enabled: true, block });
  const sent = sentMessage(socket, 'what time is it?');
  for (const line of FRAMING) assert.ok(sent.includes(line), 'the framing rides the frame');
  for (const line of CLOSING) assert.ok(sent.includes(line), 'the closing rides the frame');
  assert.strictEqual(sent, `${block}\n\nwhat time is it?`, 'the frame carries the block, the blank line, then the words');
  // And the block that rides really ends with the closing line, before the
  // blank line the stripper needs.
  assert.ok(block.endsWith(CLOSING[CLOSING.length - 1]), 'the block ends with the closing line');
});

/* ------------------------------------------------------------- one interpreter */

/*
 * The script is data in core/spec/prompt-metadata.json, read by the desktop as
 * a JSON import and by the phone out of its bundle, so there is one copy rather
 * than one per client. This is what makes that a fact rather than an intention:
 * every distinctive line of the hook is held by exactly one file, the spec that
 * owns it. A second copy in a Swift source file, a fixture or a test would fail
 * here rather than at the moment the two dialects drifted.
 *
 * The lines are read FROM the spec rather than written out here, so this test
 * cannot become the second copy it is looking for.
 */
test('the injected script exists exactly once in the tree', () => {
  const spec = JSON.parse(
    fs.readFileSync(path.join(REPO, 'core', 'spec', 'prompt-metadata.json'), 'utf8'),
  );
  const distinctive = spec.hook.filter((line) => line.trim().length >= 30);
  assert.ok(distinctive.length >= 3, 'expected distinctive lines in the hook to search for');

  const tracked = execFileSync(
    'git', ['ls-files', '--cached', '--others', '--exclude-standard'],
    { cwd: REPO, encoding: 'utf8' },
  ).split('\n').filter(Boolean);
  assert.ok(tracked.length > 0, 'expected a git checkout to sweep');

  const sources = [];
  for (const file of tracked) {
    try {
      sources.push([file, fs.readFileSync(path.join(REPO, file), 'utf8')]);
    } catch {
      // A path that cannot be read as text (a directory, a binary) cannot hold
      // a copy of the script either.
    }
  }

  for (const line of distinctive) {
    // The spec holds these as JSON string bodies, so a line with a backslash in
    // it (the command test) appears escaped in the file. Search for the escaped
    // form, which is what a copy of the script would carry too.
    const escaped = JSON.stringify(line).slice(1, -1);
    const owners = sources.filter(([, source]) => source.includes(escaped)).map(([file]) => file);
    assert.deepStrictEqual(
      owners,
      ['core/spec/prompt-metadata.json'],
      `the injected script has been copied, and this line is held by ${owners.length} files (${owners.join(', ')}): ${line.trim()}`,
    );
  }
});

test('the hook both clients install is the spec text, byte for byte', () => {
  const spec = JSON.parse(
    fs.readFileSync(path.join(REPO, 'core', 'spec', 'prompt-metadata.json'), 'utf8'),
  );
  const lines = hookSource().split('\n');

  assert.strictEqual(lines.join('\n'), spec.hook.join('\n'));
  assert.strictEqual(lines.length, fixture.hook.lines);
  for (const part of fixture.hook.contains) {
    assert.ok(lines.join('\n').includes(part), `the hook should still mention ${part}`);
  }
  assert.strictEqual(fixture.hook.owner, 'core/spec/prompt-metadata.json');
});

test('installing the script twice updates the configuration and hooks send once', () => {
  const first = formatBlock({ host: 'example-host', client: 'Claw Control UI (claw-desktop) 1.0.0' });
  const second = formatBlock({ host: 'example-host', client: 'Claw Control UI (claw-desktop) 1.0.0' });
  const context = { window: {}, WebSocket: class { send() {} } };

  vm.runInNewContext(clientScript({ enabled: true, block: first }), context);
  const installed = context.WebSocket.prototype.send;
  vm.runInNewContext(clientScript({ enabled: true, block: second }), context);

  assert.strictEqual(context.WebSocket.prototype.send, installed, 'a second install must not stack another hook');
  assert.strictEqual(context.window.__clawPromptMetadata.block, second, 'the configuration is what updates');
});

/* ------------------------------------------------- the script matches the rules */

/*
 * The script implements the two injection rules inline, because a page cannot
 * import a module. This drives the pinned fixture cases through both, so the
 * inline copy cannot drift from the pure one without a failure here.
 */
test('the injected script applies the same rules as shouldInject', () => {
  const block = formatBlock({ host: 'example-host' });
  const socket = hookedSocket({ enabled: true, block });

  assert.ok(fixture.shouldInject.length > 0, 'expected shouldInject fixtures');
  for (const { input, output } of fixture.shouldInject) {
    assert.strictEqual(
      shouldInject(input.message),
      output,
      `shouldInject(${JSON.stringify(input.message)}) should be ${output}`,
    );
    assert.strictEqual(
      sentMessage(socket, input.message) !== input.message,
      output,
      `the script disagreed with shouldInject on ${JSON.stringify(input.message)}`,
    );
  }
});

test('the injected script produces exactly what inject() produces', () => {
  assert.ok(fixture.inject.length > 0, 'expected inject fixtures');
  for (const { name, input } of fixture.inject) {
    const socket = hookedSocket({ enabled: true, block: input.block });
    assert.strictEqual(
      sentMessage(socket, input.message),
      inject(input.message, input.block),
      `${name}: the script and inject() disagree`,
    );
  }
});

test('the script decorates a real chat.send frame and leaves every other frame alone', () => {
  const block = formatBlock({ host: 'example-host' });
  const socket = hookedSocket({ enabled: true, block });
  const untouched = [
    'not json',
    JSON.stringify({ method: 'chat.send', params: {} }),
    JSON.stringify({ method: 'chat.send' }),
    JSON.stringify({ method: 'chat.send', params: { message: '/status' } }),
    JSON.stringify({ method: 'chat.send', params: { message: `${block}\n\nhello` } }),
  ];

  for (const frame of untouched) {
    socket.send(frame);
    assert.strictEqual(socket.sent, frame);
  }

  const frame = JSON.stringify({ method: 'chat.send', params: { message: 'hello' } });
  socket.send(frame);
  assert.strictEqual(JSON.parse(socket.sent).params.message, `${block}\n\nhello`);
});

test('the script rewrites outbound frames only, because the gateway does the hiding', () => {
  const script = hookSource();
  assert.doesNotMatch(script, /addEventListener/);
  assert.doesNotMatch(script, /onmessage/);
  assert.doesNotMatch(script, /\bfetch\b/);
  assert.match(script, /WebSocket\.prototype\.send/);
});

test('the platform-free module gathers nothing of its own', () => {
  const source = fs.readFileSync(path.join(REPO, 'core', 'prompt-metadata.js'), 'utf8');
  assert.doesNotMatch(source, /node:os|node:fs|process\.platform|Intl\./, 'gathering belongs to each client');
  assert.match(source, /import spec from '\.\/spec\/prompt-metadata\.json'/, 'the data comes from the spec');
});

test('a value is stringified before it is cleaned, so a caller cannot inject a type', () => {
  // Each client gathers strings, so this is a rule about the module's contract
  // rather than about anything either client sends today.
  assert.strictEqual(clean(123), '123');
  assert.strictEqual(clean(undefined), 'unknown');
});

test('a disabled configuration still leaves the frame byte-identical', () => {
  const frame = JSON.stringify({ method: 'chat.send', params: { message: 'hello' } });
  const socket = hookedSocket({ enabled: false, block: formatBlock({ host: 'example-host' }) });
  socket.send(frame);
  assert.strictEqual(socket.sent, frame);
  assert.strictEqual(
    transformFrame(frame, { enabled: false, block: 'x' }),
    frame,
    'the pure transformer agrees with the injected one',
  );
});
