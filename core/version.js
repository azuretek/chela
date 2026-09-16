// What a version IS, and how two of them compare.
//
// The shared half of versioning: the parser, the formatter, and the semver
// precedence comparison. It lives in core because more than one place needs it
// now and they cannot import each other otherwise. The desktop's CI build
// tooling (desktop/scripts/version.js) re-exports these and adds the build-only
// pieces on top (the dev-version scheme, the tag/package.json check); core/feed.js
// reads a feed and asks "is this newer" with `isNewer`; and the iOS client ports
// the same rule (mobile/Claw/Version.swift), proven against the golden fixture in
// fixtures/version.json that desktop/test/version.test.js asserts. One rule, one
// comparator, three consumers.
//
// No semver dependency: the app has no runtime dependencies, this also runs in CI
// where installing one is not free, and the subset needed is small and closed.
// Anything this rejects is something a build should stop for anyway.

// `MAJOR.MINOR.PATCH`, optionally `-prerelease`, and nothing else. Deliberately
// stricter than semver proper: build metadata (`+sha`) is not accepted, because
// electron-builder puts the version straight into filenames and `+` is awkward
// in a URL. Prerelease identifiers are limited to the same alphabet for the
// same reason.
const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** Parse a version string, or null if it is not one we will release. */
export function parse(version) {
  const m = VERSION_RE.exec(String(version || '').trim());
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] || null,
  };
}

export function format({ major, minor, patch, prerelease }) {
  return `${major}.${minor}.${patch}${prerelease ? `-${prerelease}` : ''}`;
}

/**
 * Compare two versions by semver precedence: -1, 0 or 1 for a<b, a==b, a>b.
 *
 * This is the comparison electron-updater delegates to `semver` on the desktop,
 * written out here because it is now needed somewhere `semver` is not: the iOS
 * client's update check has to ask "is the feed's newest build newer than mine"
 * with the same answer the desktop reaches, and its Swift port (Version.swift)
 * is proven against this through the shared fixture. So the rule lives once, in
 * the module that already owns what a version IS, rather than being reimplemented
 * on the phone.
 *
 * Semver Section 11 is the whole of it, and the two halves that are easy to get
 * wrong are the ones the existing dev-version tests already lean on:
 *
 *   - The numeric fields compare as NUMBERS. `1.0.10` is above `1.0.9`, which a
 *     string compare gets backwards.
 *   - A prerelease has LOWER precedence than its associated release: `1.0.1-dev.5`
 *     is below `1.0.1`, not above it. This is what keeps a dev build sorting under
 *     the release it is heading towards, and a stable build never being offered a
 *     dev one.
 *
 * Within a prerelease, identifiers are compared left to right: an all-digit one
 * numerically, anything else ASCII-lexically, a numeric identifier always below a
 * non-numeric one, and a longer run of identifiers above a shorter prefix of it.
 * That is what makes `dev.10` sort above `dev.9` (the count is numeric) while a
 * sha, which is not, never decides an ordering it should not.
 *
 * An unparseable version throws rather than sorting arbitrarily: a feed that
 * handed the check a value this cannot read is a fault to surface, not a silent
 * "not newer" that would leave a real update unnoticed.
 */
export function compare(a, b) {
  const left = parse(a);
  const right = parse(b);
  if (!left) throw new Error(`not a version: ${a}`);
  if (!right) throw new Error(`not a version: ${b}`);

  for (const field of ['major', 'minor', 'patch']) {
    if (left[field] !== right[field]) return left[field] < right[field] ? -1 : 1;
  }

  // Equal core versions. A version with no prerelease outranks one that has it,
  // and two without are equal.
  if (left.prerelease === right.prerelease) return 0;
  if (left.prerelease === null) return 1;
  if (right.prerelease === null) return -1;

  return comparePrerelease(left.prerelease, right.prerelease);
}

/** Whether `candidate` is strictly newer than `current`. */
export function isNewer(candidate, current) {
  return compare(candidate, current) > 0;
}

// The dot-separated identifiers of two prerelease strings, compared per semver
// Section 11.4. Split out only so compare() reads as the core-then-prerelease
// shape semver actually is.
function comparePrerelease(a, b) {
  const left = a.split('.');
  const right = b.split('.');
  const shared = Math.min(left.length, right.length);

  for (let i = 0; i < shared; i += 1) {
    const result = compareIdentifier(left[i], right[i]);
    if (result !== 0) return result;
  }

  // Every shared identifier is equal, so the one with more identifiers is the
  // higher-precedence version (`dev.5.a` outranks `dev.5`).
  if (left.length === right.length) return 0;
  return left.length < right.length ? -1 : 1;
}

// One prerelease identifier against another. All-digit identifiers compare
// numerically and rank below any identifier that is not all digits; two
// non-numeric ones compare ASCII-lexically.
function compareIdentifier(a, b) {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  if (aNumeric && bNumeric) {
    const na = Number(a);
    const nb = Number(b);
    return na === nb ? 0 : (na < nb ? -1 : 1);
  }
  if (aNumeric) return -1;
  if (bNumeric) return 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
