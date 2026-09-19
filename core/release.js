// What a release must carry, and whether one is complete.
//
// One release names one version, and every package that version distributes is
// built from the same commit: the desktop installers for three platforms and two
// architectures with the updater metadata electron-updater resolves them
// through, and the iOS app with the OTA manifest that installs it.
//
// This module is where that set is decided and where a release is judged against
// it, because the judgement is needed in more than one place: the CI entry point
// both pipelines call, the mobile lane that writes the manifest, and a person
// checking a published release by hand.
//
// Pure, like every other core module: no fetch, no clock, no filesystem. Assets
// arrive as an array of names and the answer is a value, so the same question can
// be asked of a directory listing, of a GitHub release, or of a fixture in a test.
//
// The names live in spec/release.json, and the channel values come from
// spec/feed.json, which already owns them for the releases feed. The iOS client
// mirrors only the OTA names it needs to build an install URL, the same way
// Naming.swift mirrors spec/naming.json.

import spec from './spec/release.json' with { type: 'json' };
import feedSpec from './spec/feed.json' with { type: 'json' };
import { DEV_CHANNEL, IOS_MARKER } from './feed.js';
import { parse } from './version.js';
import { product, mobile, repo } from './naming.js';

export const tagPrefix = spec.tagPrefix;
export const ota = spec.ota;

// The marker line a release carries when a TestFlight build of it is
// installable, and the line release.yml appends to the release body to write it.
//
// The bare marker is owned by feed.js (IOS_MARKER), which is where the two
// clients read it from, so this is only the WRITER's shape: the same string on a
// line of its own, which is how it survives into the entry's <content> that the
// phone reads. re-exported so a caller reads one string from one module rather
// than rebuilding the line where it is stamped.
export const iosMarker = IOS_MARKER;

// The body line release.yml appends when the mobile pipeline produced a VALID
// TestFlight build for this commit. A leading marker on its own line so a reader
// substring-matching the marker cannot be fooled by prose that happens to quote
// it, and so a human reading the notes sees one plain line rather than markup.
export function iosMarkerLine() {
  return IOS_MARKER;
}

// The two tokens a pattern may carry. A pattern is a filename with {version} and
// {channel} in it, and everything else in it is literal.
function fill(pattern, version, channel) {
  return pattern
    .replaceAll('{version}', version)
    .replaceAll('{channel}', feedSpec.channels[channel] || channel);
}

// A required pattern as a matcher. Dots in the literal parts are escaped because
// asset names hold them, and each token matches the shape of the thing it stands
// for rather than any run of characters: a channel token that accepted anything
// would make {channel}.yml claim builder-debug.yml.
const VERSION_RE = '[0-9]+\\.[0-9]+\\.[0-9]+(?:-[0-9A-Za-z.]+)?';
const CHANNEL_RE = '(?:' + Object.values(feedSpec.channels).join('|') + ')';

function patternToRegExp(pattern) {
  const escaped = pattern.replaceAll('.', '\\.');
  const body = escaped
    .replaceAll('{version}', VERSION_RE)
    .replaceAll('{channel}', CHANNEL_RE);
  return new RegExp('^' + body + '$');
}

export function childNames() {
  return Object.keys(spec.children);
}

// Every asset a release must carry, in a stable order: the children in the order
// the spec lists them.
export function requiredAssets(version, options) {
  const out = [];
  for (const child of childNames()) {
    out.push(...requiredAssetsFor(child, version, options));
  }
  return out;
}

export function requiredAssetsFor(child, version, options) {
  const group = spec.children[child];
  if (!group) throw new Error('no such child client: ' + child);
  const channel = (options && options.channel) || DEV_CHANNEL;
  return group.assets.map((pattern) => fill(pattern, version, channel));
}

// Which child an asset belongs to, by an exact required pattern first and by the
// child's own prefix second, so a companion file such as a blockmap is still
// attributed. Null means the release carries something no child claims.
export function childOf(asset) {
  for (const child of childNames()) {
    for (const pattern of spec.children[child].assets) {
      if (patternToRegExp(pattern).test(asset)) return child;
    }
  }
  for (const child of childNames()) {
    const prefix = spec.children[child].prefix;
    if (prefix && asset.startsWith(prefix)) return child;
  }
  return null;
}

export function missingAssets(version, assets, options) {
  const have = new Set(assets || []);
  return requiredAssets(version, options).filter((name) => !have.has(name));
}

// The full answer, for a gate that has to say what is missing and whose it is
// rather than only that something is.
export function completeness(version, assets, options) {
  const missing = missingAssets(version, assets, options);
  const missingByChild = {};
  for (const name of missing) {
    const child = childOf(name) || 'unknown';
    if (!missingByChild[child]) missingByChild[child] = [];
    missingByChild[child].push(name);
  }
  const unexpected = (assets || []).filter((name) => childOf(name) === null);
  return { complete: missing.length === 0, missing, missingByChild, unexpected };
}

export function isComplete(version, assets, options) {
  return missingAssets(version, assets, options).length === 0;
}

export function releaseTag(version) {
  return spec.tagPrefix + version;
}

// The version a tag names, or null. A full ref is accepted because CI hands over
// refs/tags/v1.2.3 while a person types v1.2.3.
export function versionFromTag(tag) {
  if (typeof tag !== 'string') return null;
  const bare = tag.startsWith('refs/tags/') ? tag.slice('refs/tags/'.length) : tag;
  if (!bare.startsWith(spec.tagPrefix)) return null;
  const version = bare.slice(spec.tagPrefix.length);
  return version.length > 0 ? version : null;
}

// The three integer form: what Apple accepts as a bundle version, and what the
// OTA manifest reports, while the release and the tag carry the dev build's full
// identity. version.js owns what a version is; this is the one projection release
// work needs from it.
export function marketing(version) {
  const parsed = parse(version);
  if (!parsed) return null;
  return parsed.major + '.' + parsed.minor + '.' + parsed.patch;
}

// Where a release asset is downloadable from, which is also what the manifest
// names and what the install URL points at.
export function assetUrl(version, asset) {
  return 'https://github.com/' + repo + '/releases/download/' + releaseTag(version) + '/' + asset;
}

export function otaAppAsset(version) {
  return fill(spec.ota.appAsset, version, DEV_CHANNEL);
}

export function otaManifestAsset(version) {
  return fill(spec.ota.manifestAsset, version, DEV_CHANNEL);
}

export function otaInstallUrl(version) {
  return spec.ota.urlScheme + assetUrl(version, otaManifestAsset(version));
}

// The OTA manifest an iOS install is driven by: what the phone downloads when it
// is told to update, naming the app asset on the same release. Built here rather
// than in the pipeline so the naming has one owner and a test can read it.
export function otaManifest(options) {
  const version = options.version;
  const bundleId = options.bundleId || mobile.bundleId;
  const title = options.title || product;
  const appUrl = options.appUrl || assetUrl(version, otaAppAsset(version));
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>items</key>',
    '  <array>',
    '    <dict>',
    '      <key>assets</key>',
    '      <array>',
    '        <dict>',
    '          <key>kind</key>',
    '          <string>' + spec.ota.kind + '</string>',
    '          <key>url</key>',
    '          <string>' + appUrl + '</string>',
    '        </dict>',
    '      </array>',
    '      <key>metadata</key>',
    '      <dict>',
    '        <key>bundle-identifier</key>',
    '        <string>' + bundleId + '</string>',
    '        <key>bundle-version</key>',
    '        <string>' + marketing(version) + '</string>',
    '        <key>kind</key>',
    '        <string>' + spec.ota.metadataKind + '</string>',
    '        <key>title</key>',
    '        <string>' + title + '</string>',
    '      </dict>',
    '    </dict>',
    '  </array>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}
