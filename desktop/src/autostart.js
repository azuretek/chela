// "Launch at login" on Linux.
//
// Electron's app.setLoginItemSettings is `@platform darwin,win32`. On Linux it
// is not an error, it is a no-op: the setting saves, the checkbox stays ticked,
// and nothing launches. A switch that lies is worse than one that is absent,
// and this app is meant to sit in the tray from boot, so the setting is the
// point rather than a nicety.
//
// The portable replacement is the XDG Desktop Application Autostart
// Specification: a .desktop entry in $XDG_CONFIG_HOME/autostart, which GNOME,
// KDE, XFCE and the rest all read. No daemon, no packaging, one file.
//
// Kept free of Electron and of fs for the same reason as updates.js: the path
// derivation and the file body are the parts that can be wrong, and both are
// pure functions of the environment.

import path from 'node:path';
import os from 'node:os';
import nodeFs from 'node:fs';
import { product, desktop } from '../../core/naming.js';

/**
 * The autostart entry's filename, which pairs with package.json `desktopName`
 * (asserted in test/naming.test.js) and with electron-builder's
 * `syncDesktopName`, which is what ties a running window back to this file.
 */
export const ENTRY = `${desktop.shorthand}.desktop`;

/**
 * Where the entry belongs.
 *
 * XDG_CONFIG_HOME wins when set to an absolute path, which is the spec's rule,
 * a relative value is "invalid and must be ignored", and honouring one would
 * scatter autostart entries relative to the process's cwd.
 */
export function entryPath({ env = process.env, home = os.homedir() } = {}) {
  const configured = env.XDG_CONFIG_HOME;
  const base = configured && path.isAbsolute(configured) ? configured : path.join(home, '.config');
  return path.join(base, 'autostart', ENTRY);
}

/**
 * The command the entry should run.
 *
 * An AppImage is the case that matters, and the case that would otherwise
 * break. `process.execPath` inside a running AppImage points into the
 * temporary mount the runtime made (/tmp/.mount_chela-dXXXXXX/chela-desktop),
 * which is unmounted the moment the app exits, so an entry written from
 * execPath names a path that does not exist by the time anything reads it, and
 * fails silently at every login. APPIMAGE is the AppImage runtime's own pointer
 * to the file the user actually keeps.
 */
export function launchCommand({ env = process.env, execPath = process.execPath } = {}) {
  return env.APPIMAGE || execPath;
}

/**
 * Quote one argument for a desktop entry's Exec field.
 *
 * Two escaping layers stack here and are easy to conflate. The desktop file
 * format escapes with backslashes at parse time, and the Exec value is then
 * word-split with its own quoting rules, where a backslash inside double quotes
 * must itself be escaped. A path containing a backslash therefore needs four in
 * the file, which is the sort of thing worth a test rather than a squint.
 */
export function quoteExec(arg) {
  const escaped = String(arg).replace(/(["`$\\])/g, '\\\\$1');
  return `"${escaped}"`;
}

/**
 * The entry's contents.
 *
 * X-GNOME-Autostart-enabled is redundant under the spec but is what GNOME's own
 * Tweaks writes, and its absence is read by some versions as disabled.
 */
export function entryBody({ exec, hidden = false, name = product } = {}) {
  const command = [quoteExec(exec), ...(hidden ? ['--hidden'] : [])].join(' ');
  return [
    '[Desktop Entry]',
    'Type=Application',
    `Name=${name}`,
    'Comment=Desktop shell for the OpenClaw Control UI',
    `Exec=${command}`,
    'Terminal=false',
    'X-GNOME-Autostart-enabled=true',
    '',
  ].join('\n');
}

/**
 * Turn the setting into a file, or remove it.
 *
 * Rewritten rather than left alone when already enabled: the AppImage's path
 * changes whenever someone moves or renames it, and a stale Exec is exactly the
 * silent failure this module exists to avoid. Writing ~300 bytes on each start
 * is cheaper than being wrong.
 *
 * @returns {{ok: boolean, error?: string, path?: string, wrote?: boolean}}
 */
export function apply({ enabled, hidden = false, fs = nodeFs, env = process.env, execPath = process.execPath, home } = {}) {
  const file = entryPath(home ? { env, home } : { env });
  try {
    if (!enabled) {
      fs.rmSync(file, { force: true });
      return { ok: true, path: file, wrote: false };
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, entryBody({ exec: launchCommand({ env, execPath }), hidden }), { mode: 0o644 });
    return { ok: true, path: file, wrote: true };
  } catch (err) {
    return { ok: false, error: err.message, path: file };
  }
}
