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
// the parsing is testable from one run and the Swift port (mobile/Chela/
// UpdateFeed.swift) has a fixture to prove itself against
// (fixtures/feed.json). Fetching the URL is the client's job, because a network
// call is exactly the part that is not portable and not pure.

import spec from './spec/feed.json' with { type: 'json' };
import { compareRelease, parse } from './version.js';
import { channelOf } from './updates.js';
// The releases LIST, which naming.js already owns because the desktop's menu
// links to it: the no-version case below is that same page, not a second one.
import { releasesUrl } from './naming.js';

/** The channel a build reads, as its spec name. `dev` today; `latest` later. */
export const DEV_CHANNEL = spec.channels.dev;
export const STABLE_CHANNEL = spec.channels.stable;

/**
 * The line a release carries in its body when, and only when, a TestFlight
 * build of that version is installable.
 *
 * It is the iOS audience's answer to a question the desktop never has to ask:
 * the desktop's own installers are on any release it published, so a release
 * that exists is one the desktop may offer. The phone cannot assume that,
 * because a desktop-only or .github-only commit produces a release with no
 * TestFlight build behind it (no mobile pipeline run at all), and the phone
 * reading that release would point the user at a build that does not exist.
 *
 * A body line rather than a release asset, because the phone reads
 * releases.atom, and an Atom entry carries the release body as its `<content>`
 * but carries no assets. So the one signal both a human and the phone can read
 * off the same release is a line in its notes. release.yml writes it at publish
 * time, when the platforms gate has already told it whether the mobile pipeline
 * produced a VALID build for this commit; this constant is the one owner of the
 * exact string, so the writer and the reader cannot drift.
 */
export const IOS_MARKER = spec.iosMarker;

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
 * The real release notes for a version, or for the channel when there is no
 * version to name.
 *
 * NOT `releasesUrl` from naming.js, which is the list, and deliberately not a
 * store page either: the notes for a release are the release's own page, which
 * is where the tag, the commit and whatever was written about the build are. A
 * link that says "release notes" and lands somewhere else is worse than no link,
 * because it spends a click to answer a question it never read.
 *
 * Built from the repo slug and `releaseNotesPath` so a rename moves it with
 * everything else, and shared so both clients land on the same page for the same
 * version rather than each building the URL in its own client.
 *
 * @param {string} repo  the `owner/name` slug, from naming.js
 * @param {string|null} [version]  the release to read; omit for the channel's list
 */
export function releaseNotesUrl(repo, version = null) {
  const base = `https://github.com/${repo}`;
  const trimmed = typeof version === 'string' ? version.trim() : '';
  return trimmed ? `${base}/${spec.releaseNotesPath}${trimmed}` : releasesUrl;
}

/**
 * Whether one Atom entry's release carries the iOS availability marker.
 *
 * The marker rides in the release body, which GitHub emits as an entry's
 * `<content>`, so this reads `entry.content` (the JS client hands the parsed
 * entry that field, the Swift client the same) and asks whether the marker
 * string appears in it. A missing or non-string content is `false`, the same
 * non-answer a feed a client did not write is entitled to: a release with no
 * body, or an entry shape this does not recognise, is not one the phone may
 * offer, which is the safe direction (a desktop-only release must be invisible
 * to the phone, not offered by accident).
 *
 * The match is a plain substring rather than a line or a JSON parse, because the
 * body is HTML by the time it reaches `<content>` and the marker is deliberately
 * plain ASCII (no `<`, `>` or `&`) so it survives HTML escaping unchanged. What
 * matters is that the exact string release.js wrote is present, and IOS_MARKER
 * is that one string.
 *
 * @param {{content?: string}} entry  one parsed Atom entry
 * @returns {boolean}
 */
export function iosAvailable(entry) {
  if (!entry || typeof entry !== 'object') return false;
  const content = typeof entry.content === 'string' ? entry.content : null;
  if (content === null) return false;
  return content.includes(IOS_MARKER);
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
 * ★ The iOS audience reads a NARROWER feed than the desktop, and that is the
 * whole of the phantom-update fix. Passed `{ iosOnly: true }`, this skips any
 * entry whose release does not carry the iOS availability marker, so a
 * desktop-only release (published for a commit whose mobile pipeline never ran,
 * or ran without uploading) is invisible to the phone even though it is the
 * newest entry in the feed. The desktop passes nothing and reads every entry,
 * because a release that exists carries its own installers. The filter is here,
 * on the one function both audiences call, rather than in each client, so the
 * two cannot disagree about which entry is "the newest on the channel".
 *
 * @param {unknown} document  the parsed releases document, `{ entries: [...] }`
 * @param {string} channel    DEV_CHANNEL or STABLE_CHANNEL
 * @param {{iosOnly?: boolean}} [options]  iosOnly filters to marker-bearing releases
 * @returns {string|null}  the newest version on the channel, or null
 */
export function newestOnChannel(document, channel, options) {
  if (!document || typeof document !== 'object') return null;
  const entries = Array.isArray(document.entries) ? document.entries : null;
  if (!entries) return null;

  const iosOnly = !!(options && options.iosOnly);
  const wantPrerelease = channel === DEV_CHANNEL;
  for (const entry of entries) {
    const version = tagVersion(entry);
    if (version === null) continue;
    const parsed = parse(version);
    if (!parsed) continue;
    const isPrerelease = parsed.prerelease !== null;
    if (isPrerelease !== wantPrerelease) continue;
    // The iOS audience skips a release with no installable TestFlight build,
    // whatever its position in the feed: an unmarked release is not one the
    // phone may offer, so the reader keeps looking for the newest one that is.
    if (iosOnly && !iosAvailable(entry)) continue;
    return version;
  }
  return null;
}

/**
 * Whether the build a feed named is newer than the build we are running.
 *
 * ★ THE SIGNAL IS THE FEED'S OWN ORDERING, NOT THE VERSION STRINGS.
 *
 * "Always pick the latest" has to be anchored in something that cannot invert,
 * and the version strings can: the tail after the release is build and commit
 * information whose basis has changed, so a build published this morning can
 * carry a LOWER number than one published last week
 * (`1.0.1-dev.195.6387043585` then `1.0.1-dev.12.1758000000`). Ranking that
 * tail is what froze the updates: the check decided the installed build was
 * AHEAD of the feed and offered nothing, while the number on About appeared to
 * go backwards. The full statement of the rule is beside `compareRelease` in
 * version.js.
 *
 * So the ordering signal is the FEED ITSELF. `newestOnChannel` returns the
 * first entry belonging to this build's channel, and GitHub emits
 * releases.atom newest-first by publish time, so the entry it returns IS the
 * newest published build on the channel, whatever its tail says. This function
 * is then only asked whether that candidate is one we should NOT offer, and
 * there is exactly one such case: the feed's newest is a LOWER release than
 * ours (`1.0.0` while we run `1.0.1`), which is a step backwards.
 *
 * Same release with a different tail IS offered, and that is the reported bug
 * rather than a widening of the rule: an installed build carrying an old-scheme
 * tail looks numerically higher than every build published after it, and the
 * feed has already said which one is newer.
 *
 * The exact build we are running is the one case where the tail still counts,
 * and it counts for what it literally is: an identity, compared for equality. It
 * has to, or a check that cannot tell the feed's newest from the build in front
 * of it would offer the same build forever.
 *
 * Both versions must parse; an unreadable one throws rather than sorting
 * arbitrarily, the same contract `compare` has.
 */
export function isNewerBuild(candidate, current) {
  const from = parse(current);
  if (!from) throw new Error(`not a version: ${current}`);
  if (!parse(candidate)) throw new Error(`not a version: ${candidate}`);

  // The feed's newest IS this build: nothing to announce.
  if (candidate === current) return false;

  return compareRelease(candidate, current) >= 0;
}

/**
 * The newest release on a build's channel if it is newer than the build,
 * otherwise null.
 *
 * This is the whole question the update check asks, in one place so the client
 * is a fetch and a branch rather than a second copy of the comparison. `null`
 * means "nothing to say", which covers both a document with no release on this
 * channel and one whose newest is not newer than this build, the two cases the
 * banner must stay absent for.
 *
 * The candidate is the feed's newest on this build's channel and the decision is
 * `isNewerBuild`, so both clients reach the same answer from the same rule and
 * Version.swift ports the pair rather than a second comparator. The channel is
 * the build's own (`channelFor`), so a dev build is only ever compared against
 * dev releases and a stable build against stable ones.
 *
 * ★ The iOS audience passes `{ iosOnly: true }`, which is the whole fix: the
 * candidate it compares against is the newest release CARRYING A TESTFLIGHT
 * BUILD, not merely the newest release, so the phone never announces a
 * desktop-only version. The desktop passes nothing and keeps reading every
 * release, because its installers are on any release it published. Both reach
 * the same `isNewerBuild` rule, so the audience changes which candidate is
 * chosen, never how newer is decided.
 *
 * @param {unknown} document  the parsed releases document
 * @param {string} current    this build's own version
 * @param {{iosOnly?: boolean}} [options]  iosOnly filters to marker-bearing releases
 * @returns {string|null}  the newer version to announce, or null
 */
export function newerVersion(document, current, options) {
  // A current version this build cannot even parse is our own bug, not the
  // feed's, and it must not silently suppress an update: surface it.
  if (!parse(current)) throw new Error(`not a version: ${current}`);
  const advertised = newestOnChannel(document, channelFor(current), options);
  if (advertised === null) return null;
  return isNewerBuild(advertised, current) ? advertised : null;
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
