// What version a CI build carries, and whether a tag build is self-consistent.
//
// Bumping and tagging are release-it's job (see .release-it.cjs); this is the
// half release-it cannot do, because it concerns builds that are not releases:
// naming an untagged build for its commit, and refusing a tag that disagrees
// with package.json.
//
// What a version IS, and how two compare, is not here: parse, format, compare
// and isNewer live in core/version.js, because more than one thing needs them
// now (this CI tooling, core/feed.js, and the iOS client's Swift port) and a
// second copy of the comparator is exactly what the shared module exists to
// prevent. They are re-exported below so this module's own callers and tests
// keep importing one place, and the build-only pieces that ARE this module's
// (the dev-version scheme, the tag/package.json check) are built on top.

// `release`/`compareRelease`/`isNewerRelease` are re-exported for the same
// reason as the rest: they are the comparison an UPDATE CHECK is allowed to
// make, and the one it must never make is `compare`. See core/version.js.
export { parse, format, compare, isNewer, release, compareRelease, isNewerRelease } from '../../core/version.js';
import { parse, format } from '../../core/version.js';

/**
 * The version a tag or ref names, or null.
 *
 * Accepts both the bare tag and the full ref, because CI hands over
 * `refs/tags/v1.2.3` while a person types `v1.2.3`.
 *
 * The `v` prefix is not decided here, `.release-it.cjs` owns `tagName`, so
 * this only has to read what that produces.
 */
export function versionFromTag(ref) {
  const tag = String(ref || '').replace(/^refs\/tags\//, '');
  if (!tag.startsWith('v')) return null;
  const version = tag.slice(1);
  return parse(version) ? version : null;
}

/** The next patch version, with any prerelease dropped. */
export function nextPatch(base) {
  const v = parse(base);
  if (!v) throw new Error(`not a releasable version: ${base}`);
  return format({ major: v.major, minor: v.minor, patch: v.patch + 1, prerelease: null });
}

/**
 * The version an untagged build should carry: `1.0.1-dev.<count>.<sha>`.
 *
 * Three things have to be true at once, and each part earns its place.
 *
 * It must sort ABOVE the last release and below the next, so it names the NEXT
 * patch. Dev builds used to carry the current version (`1.0.0-dev.…`), which
 * sorts below `1.0.0`, fine while dev builds were only artifacts, wrong now
 * that they are a channel people install: every build after the 1.0.0 release
 * would look older than the release.
 *
 * It must INCREASE, so the count of commits leads. A commit sha does not order:
 * semver compares prerelease identifiers ASCII-lexically, so `dev.f3a1…` and
 * `dev.a92b…` sort by whichever hash happens to be smaller, and an updater's
 * "is this newer" becomes a coin flip. A count is monotonic on a branch that
 * only gains commits, and unlike a CI run number a local build can reproduce it.
 *
 * It must name the exact code, so the sha stays. It costs nothing to order:
 * identifiers are compared left to right, the count differs first for any two
 * distinct commits, and the sha is only ever reached on a tie, which means the
 * same commit, hence the same sha.
 *
 * `dirty` is carried for the same reason build-info.js records it: a commit hash
 * on a build made from a modified tree describes something that was never
 * committed, so the name has to say so or it is a lie. Local builds are where
 * this actually happens.
 */
export function devVersion(base, commit, { dirty = false, count = null } = {}) {
  const target = parse(nextPatch(base));
  const sha = String(commit || '').trim().toLowerCase();

  // Dots rather than a bare concatenation so semver reads each part as its own
  // identifier; a sha that is all digits would otherwise be compared numerically
  // against `dev`.
  const parts = ['dev'];
  if (Number.isInteger(count) && count > 0) parts.push(String(count));
  if (/^[0-9a-f]{7,40}$/.test(sha)) parts.push(sha.slice(0, 10));
  if (dirty) parts.push('dirty');
  return format({ ...target, prerelease: parts.join('.') });
}

/**
 * Check that a tag build is building the version it claims.
 *
 * The whole point: `artifactName` interpolates package.json's version, so a tag
 * that disagrees with it publishes a release whose files are named for a
 * different version. It is invisible in the build log and permanent once the
 * release is published.
 *
 * release-it makes the two agree by construction, which is exactly why this
 * still exists: a tag pushed by hand bypasses release-it entirely, and that is
 * the case worth catching.
 *
 * @returns {{ok: true, version: string} | {ok: false, reason: string}}
 */
export function checkTag(ref, packageVersion) {
  const tagged = versionFromTag(ref);
  if (!tagged) return { ok: false, reason: `ref ${ref} does not name a version (want refs/tags/vX.Y.Z)` };
  if (tagged !== packageVersion) {
    return {
      ok: false,
      reason: `tag says ${tagged} but package.json says ${packageVersion}, `
        + 'the installers would be named for the wrong version. Bump with `npm run release`, which does both.',
    };
  }
  return { ok: true, version: tagged };
}
