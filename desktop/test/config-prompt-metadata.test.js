import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import config, { setUserDataDir } from '../src/config.js';

// Point config at a fresh temp profile for each case. Under CommonJS this was
// done by intercepting `require('electron')` and busting the module cache; under
// ESM the config module exposes a userData seam instead, which is the same idea
// without reaching into the loader.
function freshConfig() {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'claw-prompt-metadata-'));
  setUserDataDir(userData);
  return { config, userData };
}

test('prompt metadata defaults off and an explicit choice persists', () => {
  const { config: cfg, userData } = freshConfig();

  assert.strictEqual(cfg.get().promptMetadata, false);
  cfg.update({ promptMetadata: true });
  assert.strictEqual(cfg.get().promptMetadata, true);

  const written = JSON.parse(fs.readFileSync(path.join(userData, 'config.json'), 'utf8'));
  assert.strictEqual(written.promptMetadata, true);
});
