import path from 'node:path';
import fs from 'node:fs';

// The two names a rename moves, and they move for different reasons.
//
// `productName` is what Electron derives `app.getPath('userData')` from, so
// renaming the app silently repoints the profile at an empty directory. That
// would abandon four things at once: config.json, the notice log, the site
// storage holding the paired device identity, and the encrypted
// credentials.json, so the Gateway would see an unrecognised client and report
// a login from a new device. Which is precisely the failure this app just
// stopped causing.
//
//   CURRENT_NAME    the userData directory, which follows the product. Moved
//                   into place by migrate() on the first launch after a rename.
//   KEYCHAIN_NAME   the identity Electron's safeStorage finds its keychain item
//                   under. That item is named `<app name> Safe Storage`
//                   (measured: see the probe in the commit that added this), and
//                   a keychain item's NAME is how its key is found. So a rename
//                   does not move this item, it orphans it: every value in
//                   credentials.json is encrypted with the password held in the
//                   OLD item, and a build asking the Keychain for a new name
//                   gets a new random password and cannot read one byte of it.
//                   This therefore stays at the last name the item was created
//                   under, deliberately and permanently, the same way the bundle
//                   id stays when the product name changes. Pinning the profile
//                   DIRECTORY instead would solve the same problem by never
//                   renaming anything, but it leaves a directory named after a
//                   product that no longer exists, and the README tells people to
//                   open it.
//
// Deliberately a plain function over an explicit base directory rather than
// something that reaches for `app.getPath()` itself. It is the only code here
// that renames a directory full of credentials, so it has to be testable
// without launching Electron and without any chance of touching a real profile.
// (Learned the hard way: `HOME` does not redirect `app.getPath('appData')` on
// macOS, so an "isolated" Electron run moved the live profile instead. The
// launch harness uses CFFIXED_USER_HOME, which does.)

// Newest first: a profile is only ever migrated from the name immediately
// before it, so if two predecessors are both present the newer one is the live
// profile and the older is left alone as evidence rather than merged.
export const PREVIOUS_NAMES = ['Claw Desktop', 'OpenClaw'];
export const CURRENT_NAME = 'Claw Control UI';
export const KEYCHAIN_NAME = 'Claw Desktop';

/**
 * Move an old-name profile into place, once.
 *
 * @param {string} appDataDir  Parent of the profile directories.
 * @param {object} [opts]
 * @param {string[]} [opts.previousNames]  Names to migrate from, newest first.
 * @param {string} [opts.currentName]      Name to migrate to.
 * @returns {{status: string, from?: string, to: string, error?: string}}
 *   `migrated` | `already-current` (target exists, never overwrite) |
 *   `nothing-to-migrate` | `failed`
 */
export function migrate(appDataDir, {
  previousNames = PREVIOUS_NAMES,
  currentName = CURRENT_NAME,
} = {}) {
  const to = path.join(appDataDir, currentName);

  // Target first: if a current-name profile exists it is authoritative, and
  // merging two profiles is never the right answer.
  if (fs.existsSync(to)) return { status: 'already-current', to };

  for (const previousName of previousNames) {
    const from = path.join(appDataDir, previousName);
    if (!fs.existsSync(from)) continue;
    try {
      fs.renameSync(from, to);
      return { status: 'migrated', from, to };
    } catch (err) {
      // Not fatal: a fresh profile still works, it just has to sign in again.
      return { status: 'failed', from, to, error: err.message };
    }
  }

  return { status: 'nothing-to-migrate', to };
}
