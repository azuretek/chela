import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { template, COMMANDS } from '../src/menus.js';

const read = (file) => fs.readFileSync(new URL('../../' + file, import.meta.url), 'utf8');

test('client reload and cache-clear entry points are absent on every desktop platform', () => {
  assert.ok(!COMMANDS.includes('reload'));
  assert.ok(!COMMANDS.includes('clearCache'));
  for (const platform of ['darwin', 'linux', 'win32']) {
    const commands = Object.fromEntries(COMMANDS.map((id) => [id, { label: id, click() {} }]));
    const menu = template({ platform, appName: 'Client', commands });
    assert.doesNotMatch(JSON.stringify(menu), /clearCache|CmdOrCtrl\+R|"reload"/);
    assert.match(JSON.stringify(menu), /reconnect/);
  }
});

test('shared About and native bridges have no cache-clear contract', () => {
  for (const file of ['core/ui/about.html', 'core/ui/about.js', 'desktop/src/preload.cjs',
    'mobile/Chela/AboutHost.swift', 'mobile/Chela/GatewayPage.swift', 'mobile/Chela/ContentView.swift']) {
    assert.doesNotMatch(read(file), /clear-cache|clearCacheAndReload|clearCachedCode|reloadFromServer|restartAfterClear/, file);
  }
});

test('gateway loads and app upgrades cannot probe builds or clear caches', () => {
  assert.equal(fs.existsSync(new URL('../src/cache.js', import.meta.url)), false);
  assert.doesNotMatch(read('desktop/src/main.js'), /maybeRefreshForNewBuild|clearOnAppUpgrade|appBuildId|cache\.clear|SW_SOURCE_PROBE|app:clear-cache/);
  assert.doesNotMatch(read('core/config-model.js'), /swVersions|appBuild/);
  assert.doesNotMatch(read('desktop/src/config.js'), /swVersions/);
  const webView = read('mobile/Chela/WebView.swift');
  const termination = webView.slice(webView.indexOf('func webViewWebContentProcessDidTerminate'),
    webView.indexOf('func resumeTerminatedRenderer'));
  assert.ok(termination.includes('resumeTerminatedRenderer()'));
  assert.doesNotMatch(termination, /webView\.reload/);
  const recovery = webView.slice(webView.indexOf('func resumeTerminatedRenderer'),
    webView.indexOf('private func report'));
  assert.match(recovery, /rendererRecoveryPending, !rendererRecoveryUsed, !rendererRecoveryCancelled/);
  assert.match(recovery, /applicationState == \.active/);
  assert.match(recovery, /rendererRecoveryUsed = true[\s\S]*webView\.reload\(\)/);
  assert.match(webView, /appliedRetryTick != pairing\.retryTick/);
  assert.match(webView, /webView\.reload\(\)/);
});
