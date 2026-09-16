// The public update feed a client reads to learn a release exists.
//
// This is the half of the update story that lives outside a signing accident.
// `updates.js` answers what a build may DO about a newer version; this answers
// where a client learns there is one, and how it reads the answer. They are
// separate because the desktop needs only the first: electron-updater has its
// own GitHubProvider that walks the releases feed and reads the channel `.yml`,
// so the desktop's "is there a newer build" is answered inside a dependency. The
// iOS client has no such dependency and cannot authenticate to the gateway yet,
// so it reads the SAME public releases the desktop does, directly, and the shape
// of that read is what this module owns.
//
// The feed is the repository's GitHub Releases, read as the Atom document GitHub
// serves at `github.com/<owner>/<repo>/releases.atom`. There is nothing to
// publish: a release already exists per build, so this reads the record the
// repository already has rather than a second copy hand-published beside it. It
// is releases.atom rather than `api.github.com/.../releases` for the reason the
// desktop's provider is too: the Atom feed is CDN-served with no 60-per-hour
// unauthenticated rate limit, which a dev build's five-minute check would
// otherwise share across every device behind one IP.
//
// Pure and platform-free, like every other core module: no fetch, no clock, no
// URL session. The client supplies the bytes it fetched and this reads them, so
// the parsing is testable from one run and the Swift port (mobile/Claw/
// UpdateFeed.swift) has a fixture to prove itself against
// (fixtures/feed.json). Fetching the URL is the client's job, because a network
// call is exactly the part that is not portable and not pure.

import spec from './spec/feed.json' with { type: 'json' };
import { isNewer, parse } from './version.js';
import { channelOf } from './updates.js';

/** The channel a build reads, as its spec name. `dev` today; `latest` later. */
export const DEV_CHANNEL = spec.channels.dev;
export const STABLE_CHANNEL = spec.channels.stable;

/**
 * The public URL a client reads for the repository's releases.
 *
 * Built from the repo slug rather than written out, so a rename moves it with
 * everything else naming.js owns. It is the releases Atom feed, one URL for both
 * channels: the document lists every release newest-first, and the reader picks
 * the newest that belongs to the caller's channel. There is no per-channel URL
 * because there is nothing per-channel to publish; the tag on each entry is what
 * says which channel it is.
 *
 * releases.atom rather than the JSON API on purpose: it is served by the release
 * CDN, so it carries no api.github.com rate limit, which is what lets a dev
 * build check every five minutes without a shared-IP limit ever applying. The
 * same URL the desktop's electron-updater provider reads.
 *
 * @param {{owner: string, name: string}} repo  from naming.js
 */
export function feedUrl({ owner, name }) {
  return `https://github.com/${owner}/${name}/${spec.releasesPath}`;
}

/**
 * The version tag of one Atom entry, as a version string, or null.
 *
 * GitHub's releases.atom names the release in the entry `<id>`, which ends
 * `.../releases/<tag>`, and also in `<title>`. The `<id>` is the reliable one:
 * a title can be an arbitrary release name, but the id always carries the tag.
 * The tag is `v<version>`, so the leading `v` is stripped and what remains is
 * handed to the version parser unchanged.
 *
 * Returns null for an entry that carries no recoverable tag, the same non-answer
 * a missing field is: a feed is a remote document the client did not write, and
 * a shape it does not recognise is not a reason to crash a background check.
 *
 * @param {{id?: string, title?: string}} entry  one parsed Atom entry
 * @returns {string|null}
 */
export function tagVersion(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const source = typeof entry.id === 'string' && entry.id ? entry.id : entry.title;
  if (typeof source !== 'string') return null;
  const tag = source.split('/').pop();
  if (!tag) return null;
  const trimmed = tag.trim().replace(/^v/, '');
  return trimmed ? trimmed : null;
}

/**
 * The newest release on a channel, from a releases document, or null.
 *
 * The document is `{ entries: [...] }`, each entry an object the client parsed
 * from one Atom `<entry>` (its `<id>` and `<title>`). Entries arrive newest
 * first, which is how GitHub orders releases.atom, so the first entry whose tag
 * belongs to the wanted channel is the newest release on it.
 *
 * The channel test is the tag's own prerelease body, the same signal
 * `channelOf` reads: a `dev` request wants a tag with a prerelease identifier
 * (`1.0.1-dev.N.sha`), a stable request wants one with none (`1.0.1`). Atom does
 * not carry GitHub's `prerelease` boolean, so the tag is the only channel
 * signal, and it is the honest one because a build cannot be wrong about the
 * tag it was released under.
 *
 * An entry whose tag does not parse is skipped rather than throwing: a
 * repository can carry a hand-made tag that is not one of ours, and a background
 * check reading past it is correct. The version that DOES get compared, in
 * `newerVersion`, is the one this returned, and that one parsed here.
 *
 * @param {unknown} document  the parsed releases document, `{ entries: [...] }`
 * @param {string} channel    DEV_CHANNEL or STABLE_CHANNEL
 * @returns {string|null}  the newest version on the channel, or null
 */
export function newestOnChannel(document, channel) {
  if (!document || typeof document !== 'object') return null;
  const entries = Array.isArray(document.entries) ? document.entries : null;
  if (!entries) return null;

  const wantPrerelease = channel === DEV_CHANNEL;
  for (const entry of entries) {
    const version = tagVersion(entry);
    if (version === null) continue;
    const parsed = parse(version);
    if (!parsed) continue;
    const isPrerelease = parsed.prerelease !== null;
    if (isPrerelease === wantPrerelease) return version;
  }
  return null;
}

/**
 * The newest release on a build's channel if it is strictly newer than the
 * build, otherwise null.
 *
 * This is the whole question the update check asks, in one place so the client
 * is a fetch and a branch rather than a second copy of the comparison. `null`
 * means "nothing to say", which covers both a document with no release on this
 * channel and one whose newest is this build or older, the two cases the banner
 * must stay absent for.
 *
 * The comparison is `isNewer` from version.js, the same one the desktop's
 * updater reaches through semver and the same one Version.swift ports, so a
 * build the desktop would offer an update to is one the phone offers one to as
 * well. The channel is the build's own (`channelFor`), so a dev build is only
 * ever compared against dev releases and a stable build against stable ones.
 *
 * @param {unknown} document  the parsed releases document
 * @param {string} current    this build's own version
 * @returns {string|null}  the newer version to announce, or null
 */
export function newerVersion(document, current) {
  // A current version this build cannot even parse is our own bug, not the
  // feed's, and it must not silently suppress an update: surface it.
  if (!parse(current)) throw new Error(`not a version: ${current}`);
  const advertised = newestOnChannel(document, channelFor(current));
  if (advertised === null) return null;
  return isNewer(advertised, current) ? advertised : null;
}

/**
 * The channel a build reads its releases as, from the build's own version.
 *
 * A dev build (`1.0.1-dev.148.abc`) reads the dev channel; a stable build reads
 * the stable one. Derived from the version rather than configured, the same
 * reason `channelOf` in updates.js is: the version is stamped at build time and
 * travels with the installed app, so a build cannot be wrong about which channel
 * it is on, where a setting could disagree with the build it is running in.
 *
 * Only the dev channel has releases with a prerelease body today, which is
 * honest about the state of the world: TestFlight is the one distribution
 * channel, and every build on it is a dev build. A stable build reads the same
 * releases document and finds the newest non-prerelease entry.
 */
export function channelFor(version) {
  return channelOf(version) === null ? STABLE_CHANNEL : DEV_CHANNEL;
}
