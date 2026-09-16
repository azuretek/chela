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
  CONTEXT_MARKER, MAX_VALUE_LENGTH, clean, clientScript, contextHeader, formatBlock,
  hookSource, inject, shouldInject, transformFrame,
} from '../prompt-metadata.js';

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
  assert.deepStrictEqual(
    lines.slice(1).map((line) => line.split(':')[0]),
    ['host', 'os', 'user', 'home', 'locale', 'timezone', 'client'],
  );
  for (const line of lines.slice(1)) {
    assert.ok(line.length < MAX_VALUE_LENGTH + 32, `unbounded line: ${line}`);
  }
});

test('the prompt is separated from the block by the blank line the stripper needs', () => {
  const block = formatBlock({ host: 'example-host' });
  assert.strictEqual(inject('hello', block), `${block}\n\nhello`);
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
