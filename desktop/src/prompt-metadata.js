import os from 'node:os';
import { readFileSync } from 'node:fs';

import { clientLabel } from '../../core/naming.js';
import {
  clientIdentity, contextHeader, clean,
} from '../../core/prompt-metadata.js';

// The block, the marker and the injected hook live in the shared core now, so
// the desktop and the phone put the same text on the same frame from the same
// source. Everything in that list is a thin re-export; what stays here is the
// one part that is honestly platform-specific, gathering this machine's facts
// with Node's `os` rather than UIKit.
export {
  CONTEXT_MARKER, FIELD_ORDER, FRAMING, CLOSING, MAX_VALUE_LENGTH, DEFAULT_CLIENT,
  contextHeader, clientIdentity, clean, formatBlock, shouldInject, inject,
  transformFrame, hookSource, clientScript,
} from '../../core/prompt-metadata.js';

/** The header this client writes, for the places that need the line itself. */
export const CONTEXT_HEADER = contextHeader('desktop');

/**
 * The version this machine's own OS reports for itself.
 *
 * \`os.release()\` is NOT it on macOS, and that is the whole reason this function
 * exists: measured 2026-09-17 on macOS 26.6.2, where it answered \`25.6.0\`, the
 * Darwin KERNEL version, so the client-context block told every agent this desktop
 * ran an OS that does not exist. The fixture never caught it because its macOS
 * example was written by hand rather than gathered.
 *
 * \`SystemVersion.plist\` is where the version a person reads is kept. Where it
 * cannot be read the kernel version is still a true fact, so it is reported rather
 * than guessed at. Linux and Windows report \`os.release()\`, which is their honest
 * kernel and build number, and this is the one place that difference lives: the
 * About sheet reads it too, so the version a reader sees and the version an agent
 * is sent cannot disagree.
 */
export function osRelease(platform = process.platform) {
  if (platform !== 'darwin') return os.release();
  try {
    const plist = readFileSync('/System/Library/CoreServices/SystemVersion.plist', 'utf8');
    const found = /<key>ProductVersion<\/key>\s*<string>([^<]+)<\/string>/.exec(plist);
    if (found) return found[1].trim();
  } catch {
    // A sandbox with no access to it falls through to the kernel version.
  }
  return os.release();
}

export function formatOs({ platform = process.platform, release = osRelease(platform), arch = os.arch() } = {}) {
  const names = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' };
  return `${names[platform] || clean(platform)} ${clean(release)} (${clean(arch)})`;
}

/** Gather only local facts that are useful when an agent reasons about this desktop. */
export function collectMetadata({
  appVersion,
  platform = process.platform,
  release = os.release(),
  arch = os.arch(),
  hostname = os.hostname(),
  userInfo = (() => {
    try { return os.userInfo(); } catch { return {}; }
  })(),
  home = (() => {
    try { return os.homedir(); } catch { return ''; }
  })(),
  locale = (() => {
    try { return Intl.DateTimeFormat().resolvedOptions().locale; } catch { return ''; }
  })(),
  timezone = (() => {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return ''; }
  })(),
} = {}) {
  return {
    host: clean(hostname),
    os: clean(formatOs({ platform, release, arch })),
    user: clean(userInfo.username || process.env.USER || process.env.USERNAME),
    home: clean(home),
    locale: clean(locale),
    timezone: clean(timezone),
    client: clean(clientIdentity(clientLabel.desktop, appVersion)),
  };
}
