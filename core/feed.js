// The public update feed a client reads to learn a release exists.
//
// This is the half of the update story that lives outside a signing accident.
// `updates.js` answers what a build may DO about a newer version; this answers
// where a client learns there is one, and how it reads the answer. They are
// separate because the desktop never needs this: electron-updater has its own
// GitHubProvider that walks the releases feed and reads the channel `.yml`, so
// the desktop's "is there a newer build" is answered inside a dependency. The
// iOS client has no such dependency and cannot authenticate to the gateway yet,
// so it reads a PUBLIC feed directly, and the shape of that feed is what this
// module owns.
//
// The feed is deliberately tiny and static: a single JSON document naming the
// newest build on a channel. It is not the electron-updater `.yml` metadata,
// which carries a download URL, a size and a checksum for a file the updater is
// about to apply; iOS applies nothing, so all it needs is the version, and a
// marker that carried an installer path would be promising something no iOS
// build can honour.
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

/** The channel a feed serves, as its filename stem. `dev` today; `latest` later. */
export const DEV_CHANNEL = spec.channels.dev;

/**
 * The public URL a client reads for a channel's newest build.
 *
 * Built from the repo slug rather than written out, so a rename moves it with
 * everything else naming.js owns, and derived from the channel so the two feeds
 * (dev now, stable later) cannot be spelled two different ways. It is a raw
 * static document on GitHub Pages: public, unauthenticated, and served by a CDN
 * built for exactly this, which is what lets the check run without the gateway
 * auth the phone does not have yet.
 *
 * The path mirrors what the mobile release workflow publishes; that workflow and
 * this function are the two ends of one contract, and `feed.json`'s `pagesPath`
 * is the single string they share.
 *
 * @param {string} channel  a channel name, e.g. DEV_CHANNEL
 * @param {{owner: string, name: string}} repo  from naming.js
 */
export function feedUrl(channel, { owner, name }) {
  return `https://${owner}.github.io/${name}/${spec.pagesPath}/${channel}.json`;
}

/**
 * The version a feed document advertises, or null if it does not name one.
 *
 * Returns null rather than throwing on a shape it does not recognise, because a
 * feed is a remote document a client did not write: a page half-deployed, an
 * error page served with a 200, or a future field this build predates all arrive
 * here, and none of them is a reason to crash a background check. A version that
 * is PRESENT but unparseable is the one thing that does throw, downstream in
 * `newerVersion`, because that is a feed actively lying about a release rather
 * than one that has not published yet.
 *
 * @param {unknown} document  the parsed JSON a client fetched
 * @returns {string|null}
 */
export function versionOf(document) {
  if (!document || typeof document !== 'object') return null;
  const { version } = document;
  return typeof version === 'string' && version.trim() ? version.trim() : null;
}

/**
 * The feed's version if it is strictly newer than this build, otherwise null.
 *
 * This is the whole question the update check asks, in one place so the client
 * is a fetch and a branch rather than a second copy of the comparison. `null`
 * means "nothing to say", which covers both a feed that names no version and a
 * feed whose version is this build or older, the two cases the banner must stay
 * absent for.
 *
 * The comparison is `isNewer` from version.js, the same one the desktop's
 * updater reaches through semver and the same one Version.swift ports, so a
 * build the desktop would offer an update to is one the phone offers one to as
 * well. An unparseable feed version throws out of `isNewer` rather than sorting
 * arbitrarily: a feed that handed the check a value it cannot read is a fault to
 * surface, not a silent "not newer" that would leave a real update unnoticed.
 *
 * @param {unknown} document  the parsed feed JSON
 * @param {string} current    this build's own version
 * @returns {string|null}  the newer version to announce, or null
 */
export function newerVersion(document, current) {
  const advertised = versionOf(document);
  if (advertised === null) return null;
  // A current version this build cannot even parse is our own bug, not the
  // feed's, and it must not silently suppress an update: let it throw.
  if (!parse(current)) throw new Error(`not a version: ${current}`);
  return isNewer(advertised, current) ? advertised : null;
}

/**
 * The channel a build should read its feed from, from the build's own version.
 *
 * A dev build (`1.0.1-dev.148.abc`) reads the dev feed; a stable build reads the
 * stable one. Derived from the version rather than configured, the same reason
 * `channelOf` in updates.js is: the version is stamped at build time and travels
 * with the installed app, so a build cannot be wrong about which channel it is
 * on, where a setting could disagree with the build it is running in.
 *
 * Only the dev channel has a feed today, which is honest about the state of the
 * world: TestFlight is the one distribution channel, and every build on it is a
 * dev build. A stable build returns the stable channel name so the caller can
 * decide there is no feed yet rather than guessing one.
 */
export function channelFor(version) {
  return channelOf(version) === null ? spec.channels.stable : DEV_CHANNEL;
}
