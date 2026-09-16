import os from 'node:os';

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
  CONTEXT_MARKER, FIELD_ORDER, MAX_VALUE_LENGTH, DEFAULT_CLIENT,
  contextHeader, clientIdentity, clean, formatBlock, shouldInject, inject,
  transformFrame, hookSource, clientScript,
} from '../../core/prompt-metadata.js';

/** The header this client writes, for the places that need the line itself. */
export const CONTEXT_HEADER = contextHeader('desktop');

export function formatOs({ platform = process.platform, release = os.release(), arch = os.arch() } = {}) {
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
