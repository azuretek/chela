// The desktop half of the opt-out issue reporter: the transport, the bounded
// queue, the installId and the crashReporter minidump policy. The redaction and
// the allowlist are core/issue-report.js, which is pure and tested; nothing that
// decides WHAT leaves the machine lives here.
//
// The default is SEND (opt-out). What is sent is a structured report built and
// scrubbed by core; a minidump is NEVER sent in the default prod lane, because a
// memory image cannot be scrubbed and holds the gateway token, pairing data and
// message content. Dev builds may opt into dumps (dev runs on our own hardware);
// prod is off behind a checkbox with a named-contents warning.

import { app, net, crashReporter } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';

import * as issueReport from '../../core/issue-report.js';

// The most a bounded queue holds, so an offline client sends later rather than
// growing a file forever. Oldest are dropped first: a fresh crash matters more
// than a stale one.
const MAX_QUEUED = 50;

let getConfig = null; // () => config object, injected so this module reads no global
let setConfig = null; // (patch) => void
let channelOf = null; // () => 'dev' | 'stable'
let queueFile = null;

/**
 * Wire the reporter to the client's config store and channel, and install the
 * process-level and crash handlers. Called once, early in whenReady.
 *
 * The handlers are installed even when reporting is OFF: turning it off stops a
 * report being SENT (enabled() is checked at send), not the app noticing it
 * crashed. That keeps the setting a privacy control rather than a switch that
 * also disables the app's own error visibility.
 */
export function init({ config, channel }) {
  getConfig = () => config.get();
  setConfig = (patch) => config.update(patch);
  channelOf = channel;
  queueFile = path.join(app.getPath('userData'), 'issue-queue.json');

  installCrashReporter();

  process.on('uncaughtException', (err) => {
    report('uncaughtException', { errorName: err && err.name, errorMessage: err && err.message, stack: err && err.stack });
  });
  process.on('unhandledRejection', (reason) => {
    const err = reason instanceof Error ? reason : new Error(String(reason));
    report('unhandledRejection', { errorName: err.name, errorMessage: err.message, stack: err.stack });
  });

  // Anything queued from a previous run that could not be sent then.
  void flushQueue();
}

/**
 * The minidump policy. crashReporter catches the case where the app dies before
 * our own code runs, but a dump is a memory image, so it is uploaded ONLY where
 * consented: dev by default, prod only when the reader ticked the box. In the
 * default prod lane no submitURL is set, so nothing is uploaded even though the
 * reporter still runs to catch the local dump for a signature.
 */
function installCrashReporter() {
  const channel = channelOf();
  const cfg = getConfig();
  const wantDumps = channel === 'dev'
    ? issueReport.minidumpsOnByDefault('dev')
    : cfg.uploadMinidumps === true; // prod: strictly opt-in behind the checkbox
  const collector = process.env[issueReport.COLLECTOR_ENV] || '';
  try {
    crashReporter.start({
      // No product/company identity in the dump metadata beyond the app name.
      uploadToServer: wantDumps && enabled() && Boolean(collector),
      submitURL: wantDumps && collector ? `${collector.replace(/\/$/, '')}/minidump` : undefined,
      compress: true,
      // Never attach extra parameters: they would ride the dump unscrubbed.
      extra: {},
      ignoreSystemCrashHandler: false,
    });
  } catch (err) {
    console.warn(`[chela-desktop] crashReporter not started: ${err && err.message}`);
  }
}

/** Whether the reader has left issue reporting on. Default ON (opt-out). */
export function enabled() {
  return getConfig().issueReporting !== false;
}

/**
 * A random installId, generated on first run and stored locally. NOT derived
 * from hardware, serial, hostname, account or device-identity.js. Resettable, so
 * a reader can sever the thread between their reports at will.
 */
function installId() {
  const cfg = getConfig();
  if (typeof cfg.installId === 'string' && cfg.installId) return cfg.installId;
  const id = crypto.randomUUID();
  setConfig({ installId: id });
  return id;
}

/** Forget the installId, so future reports cannot be tied to past ones. */
export function resetInstallId() {
  setConfig({ installId: null });
}

/**
 * Build, scrub and either send or queue one report. The report is assembled by
 * core (allowlist + redaction); this only supplies the ambient facts and the
 * transport. Never throws: a reporter that crashes the app it reports on is
 * worse than one that drops a report.
 */
export function report(kind, extra = {}) {
  try {
    if (!enabled()) return;
    const built = issueReport.buildReport({
      reportId: crypto.randomUUID(),
      installId: installId(),
      kind,
      appVersion: app.getVersion(),
      channel: channelOf(),
      platform: process.platform,
      arch: process.arch,
      osVersion: osVersionShort(),
      electronVersion: process.versions.electron,
      nodeVersion: process.versions.node,
      at: new Date().toISOString(),
      ...extra,
    });
    void send(built);
  } catch (err) {
    console.warn(`[chela-desktop] issue report dropped: ${err && err.message}`);
  }
}

/** major.minor only, so the OS build number does not narrow the machine down. */
function osVersionShort() {
  const parts = String(os.release()).split('.');
  return parts.slice(0, 2).join('.');
}

async function send(reportBody) {
  const collector = process.env[issueReport.COLLECTOR_ENV] || '';
  if (!collector) { enqueue(reportBody); return; }
  const ok = await post(collector, reportBody).catch(() => false);
  if (!ok) enqueue(reportBody);
}

function post(collector, body) {
  return new Promise((resolve) => {
    const request = net.request({ method: 'POST', url: `${collector.replace(/\/$/, '')}/report` });
    request.setHeader('Content-Type', 'application/json');
    // The collector must not store the source IP or read the User-Agent for this
    // lane; the client does its part by sending no identifying header.
    request.on('response', (response) => { resolve(response.statusCode >= 200 && response.statusCode < 300); });
    request.on('error', () => resolve(false));
    request.write(JSON.stringify(body));
    request.end();
  });
}

function readQueue() {
  try { return JSON.parse(fs.readFileSync(queueFile, 'utf8')); } catch { return []; }
}

function writeQueue(items) {
  try {
    const tmp = `${queueFile}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(items), { mode: 0o600 });
    fs.renameSync(tmp, queueFile);
  } catch (err) { console.warn(`[chela-desktop] issue queue write failed: ${err && err.message}`); }
}

function enqueue(reportBody) {
  const items = readQueue();
  items.push(reportBody);
  // Bounded: drop the oldest rather than grow forever.
  while (items.length > MAX_QUEUED) items.shift();
  writeQueue(items);
}

async function flushQueue() {
  const collector = process.env[issueReport.COLLECTOR_ENV] || '';
  if (!collector || !enabled()) return;
  const items = readQueue();
  if (!items.length) return;
  const remaining = [];
  for (const item of items) {
    const ok = await post(collector, item).catch(() => false);
    if (!ok) remaining.push(item);
  }
  writeQueue(remaining);
}

export default { init, enabled, report, resetInstallId };
