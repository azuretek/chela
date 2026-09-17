// What a release must carry, checked against the real asset list of a release
// that failed the rule.
//
// The fixture is not a second copy of the spec: it is one release exactly as
// GitHub returned it on 2026-09-17, v1.0.1-dev.215.583ac26c1f, which published
// with all sixteen desktop files and no iOS package while the phone was offered
// it. That release is the reason this module exists, so it is a case here rather
// than a paragraph somewhere.

import test from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  requiredAssets, requiredAssetsFor, missingAssets, completeness, isComplete,
  childOf, releaseTag, versionFromTag, marketing, assetUrl,
  otaManifest, otaManifestAsset, otaInstallUrl,
} from '../release.js';
import { repo } from '../naming.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(path.join(HERE, '..', 'fixtures', 'release.json'), 'utf8'));

// Every string a plist key names, in document order, so a key that appears twice
// is read rather than assumed.
function plistValues(xml, key) {
  const marker = '<key>' + key + '</key>';
  const out = [];
  let rest = xml;
  let at = rest.indexOf(marker);
  while (at !== -1) {
    const after = rest.slice(at + marker.length);
    const open = after.indexOf('<string>');
    const close = after.indexOf('</string>');
    if (open === -1 || close === -1) break;
    out.push(after.slice(open + '<string>'.length, close));
    rest = after;
    at = rest.indexOf(marker);
  }
  return out;
}

test('the published release is incomplete, and what is missing is the iOS package', () => {
  const assets = fixture.published.assets;
  assert.equal(isComplete(fixture.version, assets), false, 'a desktop-only release is not complete');
  assert.deepEqual(missingAssets(fixture.version, assets), fixture.published.missing);
  const result = completeness(fixture.version, assets);
  assert.equal(result.complete, false);
  assert.deepEqual(Object.keys(result.missingByChild), ['mobile']);
  assert.deepEqual(result.missingByChild.mobile, fixture.published.missing);
});

test('the same release becomes complete once the iOS package is added', () => {
  const assets = [...fixture.published.assets, ...fixture.published.missing];
  assert.equal(isComplete(fixture.version, assets), true);
  assert.deepEqual(missingAssets(fixture.version, assets), []);
  assert.deepEqual(completeness(fixture.version, assets).unexpected, [],
    'every asset a complete release carries belongs to a child client');
});

test('the updater metadata is required and a blockmap is not', () => {
  const required = requiredAssetsFor('desktop', fixture.version);
  assert.ok(required.includes('dev-mac.yml'), 'electron-updater cannot resolve a release without its metadata');
  assert.ok(!required.some((name) => name.endsWith('.blockmap')), 'a blockmap is a companion, not a package');
});

test('every required desktop asset is one the build actually published', () => {
  for (const name of requiredAssetsFor('desktop', fixture.version)) {
    assert.ok(fixture.published.assets.includes(name), name + ' is required but the build did not produce it');
  }
});

test('requiredAssets() is the two children together, in spec order', () => {
  const required = requiredAssets(fixture.version);
  assert.deepEqual(required.slice(0, 12), requiredAssetsFor('desktop', fixture.version));
  assert.deepEqual(required.slice(12), requiredAssetsFor('mobile', fixture.version));
});

test('childOf() attributes an asset to its child, and null for a stranger', () => {
  assert.equal(childOf('claw-desktop-1.0.1-dev.215.583ac26c1f-arm64.dmg'), 'desktop');
  assert.equal(childOf('claw-desktop-1.0.1-dev.215.583ac26c1f-x64.zip.blockmap'), 'desktop',
    'a companion file is attributed by the child prefix');
  assert.equal(childOf('dev-mac.yml'), 'desktop', 'the updater metadata is required, so it is claimed');
  assert.equal(childOf(fixture.published.missing[0]), 'mobile');
  assert.equal(childOf('builder-debug.yml'), null);
});

test('a tag and a version round trip, and anything else is null', () => {
  assert.equal(releaseTag(fixture.version), fixture.tag);
  assert.equal(versionFromTag(fixture.tag), fixture.version);
  assert.equal(versionFromTag('refs/tags/' + fixture.tag), fixture.version);
  assert.equal(versionFromTag('1.0.1'), null, 'the prefix is required, or every branch name looks like a version');
  assert.equal(versionFromTag('v'), null);
  assert.equal(versionFromTag(null), null);
});

test('marketing() is the three integer form the manifest and Apple need', () => {
  assert.equal(marketing(fixture.version), fixture.marketing);
  assert.equal(marketing('not a version'), null);
});

test('the manifest names the app asset, the bundle and the app', () => {
  const xml = otaManifest({ version: fixture.version });
  assert.deepEqual(plistValues(xml, 'kind'), [fixture.manifest.kind, fixture.manifest.metadataKind],
    'the asset kind comes first and the metadata kind second');
  assert.equal(plistValues(xml, 'url')[0], fixture.manifest.softwarePackage);
  assert.equal(plistValues(xml, 'bundle-identifier')[0], fixture.manifest.bundleIdentifier);
  assert.equal(plistValues(xml, 'bundle-version')[0], fixture.manifest.bundleVersion);
  assert.equal(plistValues(xml, 'title')[0], fixture.manifest.title);
  assert.ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>'), 'a manifest is a plist document');
});

test('the install URL is the release manifest, and the manifest is an asset of the release', () => {
  assert.equal(otaInstallUrl(fixture.version), fixture.installUrl);
  assert.equal(otaManifestAsset(fixture.version), 'claw-mobile-' + fixture.version + '.manifest.plist');
  assert.equal(otaInstallUrl(fixture.version),
    'itms-services://?action=download-manifest&url=' + assetUrl(fixture.version, otaManifestAsset(fixture.version)));
  assert.ok(assetUrl(fixture.version, 'x').startsWith('https://github.com/' + repo + '/releases/download/'),
    'assets are served from the release, over the HTTPS an OTA install requires');
});
