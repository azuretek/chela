// Which version line do the TestFlight builds belong to?
//
// WHY THIS EXISTS
//
// A version line can move and leave TestFlight behind, and nothing shows it. The
// releases feed lists what exists, the app record lists builds newest first, and a
// build from a line nobody builds any more sits in the middle of a list nobody
// reads by accident. Measured 2026-10-01: the project had moved to the 0.0.x line
// while 91 of the 92 builds in this app record were still 1.0.1, so a phone could
// install a line the repository had left.
//
// The rule asserted here is ONE LINE AT A TIME: every unexpired build must name the
// line the repository is publishing. A live build on any other line is stranded, and
// this script reports it rather than acting on it, because expiring a build is
// one-way and Apple offers no deletion at all. The choice is a person's; see
// docs/release.md, "TestFlight builds past the current line".
//
// ★ The line is NOT the newest version TestFlight holds, and not the highest one
// either. A line can move DOWN, which is what happened on 2026-10-01 when the
// project named pre-1.0 builds 0.0.*: semver ranks 1.0.1 above 0.0.1, so anything
// that inferred the line from the builds themselves would have kept the 91 stranded
// ones and reported the single current build as the stray. The line is read from
// what the repository PUBLISHES. Same reason the seed record in an update check is
// the feed rather than the highest number on the device.
//
// Read-only, and it authenticates as an App Store Connect API key, which cannot
// modify a build even if this script wanted to (PATCH /v1/builds/{id} answers 403
// for that key):
//
//   ASC_ISSUER_ID    the key's issuer id
//   ASC_KEY_ID       the key's id
//   ASC_KEY_PATH     the .p8 file
//
// A missing credential is a FAULT and exits 2, never an empty result. An audit that
// read nothing and reported "clean" is the failure this file exists to catch, so it
// refuses instead.
//
//   node scripts/release/testflight-audit.mjs                 # line from the newest release
//   node scripts/release/testflight-audit.mjs --line 0.0.1    # or named outright
//   node scripts/release/testflight-audit.mjs --json
//
// Exit 0 one line and no strays, 1 a stray exists, 2 a usage or credential fault.
//
// Speaking HTTP with node's own fetch rather than a shared client is deliberate:
// this file runs from a fresh clone and in CI, and it talks only to Apple's public
// API.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { release, compareRelease } from '../../core/version.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const API = 'https://api.appstoreconnect.apple.com';

/**
 * The app record this audits, read from the file that owns the name. Matched by
 * BUNDLE ID rather than by name: the account holds more than one product, and
 * reading an id off the app list by position is how a set of queries on 2026-10-01
 * was run against the wrong product and returned a coherent, wrong answer.
 */
export function bundleId() {
  const naming = JSON.parse(fs.readFileSync(path.join(ROOT, 'core', 'spec', 'naming.json'), 'utf8'));
  return naming.clients.mobile.bundleId;
}

/**
 * The line the repository is publishing: the newest release's version, reduced to
 * its release half.
 *
 * The releases are the record both clients read (core/feed.js), so the newest one
 * is the line the next build belongs to. A repository with no release has no line
 * to be on, and that is a fault here rather than an empty audit.
 */
export function publishedLine(run = runCommand) {
  const out = run('gh', ['release', 'list', '--limit', '1', '--json', 'tagName']);
  const releases = JSON.parse(out);
  if (!Array.isArray(releases) || !releases.length) throw new Error('no published release, so there is no line to be on');
  // The tag carries the `v` prefix release-it writes; core's parser takes the bare version.
  const line = release(String(releases[0].tagName).replace(/^v/, ''));
  if (!line) throw new Error('newest release ' + releases[0].tagName + ' does not name a version');
  return { line, tag: releases[0].tagName };
}

function runCommand(file, args) {
  return execFileSync(file, args, { cwd: ROOT, encoding: 'utf8' });
}

/**
 * Group builds by the marketing version they name, against the line.
 *
 * @param {Array<{id: string, build: string, marketing: string, expired: boolean}>} builds
 * @param {string} line  the publishing line, e.g. '0.0.1'
 * @returns {{line: string, lines: Array<{marketing: string, live: number, expired: number}>,
 *            lives: number, expired: number, strays: Array<object>, unknown: Array<object>}}
 */
export function groupByLine(builds, line) {
  const target = release(line);
  if (!target) throw new Error('not a version line: ' + line);

  const byLine = new Map();
  const unknown = [];
  const strays = [];
  for (const b of builds) {
    const named = release(b.marketing);
    if (!named) {
      unknown.push(b);
      continue;
    }
    if (!byLine.has(named)) byLine.set(named, { marketing: named, live: 0, expired: 0 });
    const entry = byLine.get(named);
    if (b.expired) entry.expired += 1;
    else {
      entry.live += 1;
      if (named !== target) strays.push(b);
    }
  }

  const lines = [...byLine.values()].sort((a, b) => compareRelease(a.marketing, b.marketing));
  return {
    line: target,
    lines,
    lives: lines.reduce((n, l) => n + l.live, 0),
    expired: lines.reduce((n, l) => n + l.expired, 0),
    strays,
    unknown,
  };
}

/** The JSON:API body for expiring a build. Kept here so the doc and the UI agree. */
export function expiryBody(id) {
  return { data: { type: 'builds', id, attributes: { expired: true } } };
}

/** An ES256 bearer token for the App Store Connect API. */
function token({ issuer, keyId, keyPath }) {
  const pem = fs.readFileSync(keyPath, 'utf8');
  const b64 = (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const now = Math.floor(Date.now() / 1000);
  const signing = b64(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' })) + '.'
    + b64(JSON.stringify({ iss: issuer, iat: now, exp: now + 300, aud: 'appstoreconnect-v1' }));
  const signature = crypto.sign('sha256', Buffer.from(signing), { key: pem, dsaEncoding: 'ieee-p1363' });
  return signing + '.' + b64(signature);
}

async function api(bearer, route) {
  const res = await fetch(API + route, { headers: { Authorization: 'Bearer ' + bearer, Accept: 'application/json' } });
  const text = await res.text();
  if (!res.ok) throw new Error(route + ' -> ' + res.status + ' ' + text.slice(0, 300));
  return JSON.parse(text);
}

/** Every build of the app, with the marketing version beside it. */
export async function fetchBuilds({ issuer, keyId, keyPath }) {
  const bearer = token({ issuer, keyId, keyPath });
  const bundle = bundleId();
  const apps = await api(bearer, '/v1/apps?limit=50&fields[apps]=name,bundleId');
  const app = apps.data.find((a) => a.attributes.bundleId === bundle);
  if (!app) throw new Error('no app record for bundle id ' + bundle);

  const route = '/v1/builds?filter[app]=' + app.id
    + '&limit=200&include=preReleaseVersion'
    + '&fields[builds]=version,uploadedDate,expired,preReleaseVersion'
    + '&fields[preReleaseVersions]=version,platform';
  const res = await api(bearer, route);
  const marketing = new Map((res.included || []).map((p) => [p.id, p.attributes.version]));
  return {
    app: { id: app.id, name: app.attributes.name, bundleId: app.attributes.bundleId },
    builds: res.data.map((b) => {
      const rel = (b.relationships || {}).preReleaseVersion || {};
      return {
        id: b.id,
        build: b.attributes.version,
        uploadedDate: b.attributes.uploadedDate,
        expired: Boolean(b.attributes.expired),
        marketing: marketing.get((rel.data || {}).id) || null,
      };
    }),
  };
}

/** The human report. */
export function report(result, app, tag) {
  const out = [];
  out.push(app.name + ' (' + app.bundleId + ', ' + app.id + ')');
  out.push('publishing line ' + result.line + (tag ? ' (' + tag + ')' : ''));
  for (const l of result.lines) {
    const mark = l.marketing === result.line ? '' : '  <- not the line';
    out.push('  ' + l.marketing + '  live ' + l.live + '  expired ' + l.expired + mark);
  }
  for (const b of result.unknown) out.push('  UNREADABLE marketing version on build ' + b.build);
  for (const b of result.strays) {
    out.push('  STRANDED ' + b.marketing + ' build ' + b.build + ' (' + b.uploadedDate + ')');
  }
  out.push(result.strays.length || result.unknown.length
    ? 'FAIL: ' + result.strays.length + ' live build(s) off line ' + result.line
      + ', ' + result.unknown.length + ' unreadable'
    : 'OK: every live build is on ' + result.line);
  return out.join('\n');
}

async function main(argv) {
  const flag = (name) => {
    const i = argv.indexOf('--' + name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : null;
  };
  const env = {
    issuer: process.env.ASC_ISSUER_ID,
    keyId: process.env.ASC_KEY_ID,
    keyPath: process.env.ASC_KEY_PATH,
  };
  const missing = Object.entries(env).filter(([, v]) => !v).map(([k]) => k);
  if (missing.length) {
    console.error('missing credential: ' + missing.join(', '));
    return 2;
  }

  const named = flag('line');
  const published = named ? { line: release(named), tag: null } : publishedLine();
  if (!published.line) throw new Error('not a version line: ' + named);

  const { app, builds } = await fetchBuilds(env);
  const result = groupByLine(builds, published.line);
  if (argv.includes('--json')) console.log(JSON.stringify({ app, tag: published.tag, ...result }, null, 2));
  else console.log(report(result, app, published.tag));
  return result.strays.length || result.unknown.length ? 1 : 0;
}

if (import.meta.url === 'file://' + process.argv[1]) {
  main(process.argv.slice(2)).then((code) => process.exit(code)).catch((e) => {
    console.error(e.message);
    process.exit(2);
  });
}
