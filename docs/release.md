# Releases

One release names one version, and every interface that distributes that version
is built from the same commit. This is the whole release story; what each
interface does with its own package is in its own README.

## Versioning

Every build, local or CI, is named for what it actually is:

| Tree state | Version |
|---|---|
| On a `v1.0.1` tag, clean | `1.0.1` |
| Any other commit, clean | `1.0.1-dev.<count>.<sha>` |
| Uncommitted changes | `1.0.1-dev.<count>.<sha>.dirty` |

The dev form carries the commit count, and that count is also the number Apple
accepts as a bundle build number, so a version name and a build number are one
number rather than two that can drift. The leading three integers are the
marketing version (`CFBundleShortVersionString`, and the name a tag has to
match); the full string is what a client reports internally and what the update
check compares.

What a version IS, and how two of them compare, is `core/version.js`, shared
by the desktop's CI tooling, the releases-feed reader and the iOS client's Swift
port. `desktop/scripts/version.js` re-exports it and adds the build-only
pieces, which are on their way into core with the release work.

**Never bump the version by hand.** `artifactName` interpolates it, so a
hand-pushed tag can publish a release named `v1.1.0` full of
`...-1.0.0-x64.exe`. The version job refuses that before either build starts.

## Triggers

| Trigger | Desktop | iOS |
|---|---|---|
| Push to `main` | A dev build and a release per commit | Tests, then a dev build for internal testing |
| Tag `v*` | A release | A release, which may also reach external testers |
| Manual dispatch | A dev build of any ref | A dev build of any ref |
| Pull request | Tests only | Tests only, no Apple credential, nothing signed |

Docs-only pushes are skipped. Several commits in a row cancel the superseded
runs, except tag builds, which are never cancelled.

## What a release must carry

One owner for the package set: `core/spec/release.json` for the names and
`core/release.js` for the logic over them, with the channel values read from
`core/spec/feed.json`, which already owns them for the feed.

| Interface | Packages |
|---|---|
| Desktop | `claw-desktop-<version>-arm64.dmg`, `-x64.dmg`, `-arm64.zip`, `-x64.zip`, `-arm64.AppImage`, `-x86_64.AppImage`, `claw-desktop-Setup-<version>-arm64.exe`, `-x64.exe`, and the updater metadata (`dev-mac.yml`, `dev.yml`, `dev-linux.yml`, `dev-linux-arm64.yml`) |
| iOS | `claw-mobile-<version>.ipa` and `claw-mobile-<version>.manifest.plist` |

The check is mechanical. The release is created as a **draft**, each interface
attaches its own assets, and the last one to finish publishes it once the
completeness check passes. Drafts do not appear in the releases feed, and the feed
is what both clients read, so a release carrying one interface's package and not
the other's cannot be announced to anyone. That is what pins the interfaces
together: the feed cannot describe a release that did not fully happen.

## Why completeness is enforced at publish, not in the client

`releases.atom` carries a tag, a title and the release notes. It does not
carry the asset list, so a client cannot see what a release holds. Publishing only
complete releases is what makes "a newer release exists" a truthful sentence for
every interface, and it is why no client-side platform filter is needed.

## How each interface distributes

**Desktop** is the release page plus the updater metadata. `electron-updater`
resolves a release by tag, reads `dev-mac.yml` on the dev channel and
`latest-mac.yml` on stable, and updates itself: Windows and Linux AppImage
replace the running build in place, macOS downloads and notifies, because
Squirrel.Mac requires a signature on the running bundle.

**iOS** installs from the OTA manifest. A sandboxed app cannot install a new build
of itself; it can ask the system to, which is what `itms-services` does. The
app's update notice opens the manifest URL, iOS shows one Install prompt, and the
app is replaced in place with its container kept.

## The move off TestFlight

TestFlight is the iOS channel today, and it stays the channel until the phone is
running an ad-hoc build. The reason is in the signature rather than the code: an
App Store-signed install cannot be replaced in place by an ad-hoc one, so the move
is **one manual install from a computer** (AltStore, Sideloadly, or Apple
Configurator from a Mac), after which every update is over the air from our own
release. Until that happens, the TestFlight upload keeps working, which is what
lets the phone be updated at all.

Ad-hoc signing needs each device's UDID registered in the developer portal, and
Apple caps registered devices per membership year. **Without a registered device
an ad-hoc profile cannot be issued at all**, so that registration is the first
step of the move.

Signing itself: the archive is automatically signed, because the App Store
Connect key plus `-allowProvisioningUpdates` lets the service mint a
development certificate per run. Such a certificate dies with the runner that
created it and accumulates in the account. The export is the step that re-signs
with an Apple Distribution certificate, and the cloud-managed distribution
certificate Xcode wants needed an Account Holder or Admin grant; the 403 recorded
on 2026-09-15 was that account-level refusal, and the runs that follow it export
and upload normally.

## Channels and pruning

`dev` is the only channel with releases. `stable` is named in
`core/spec/feed.json` so a future release build reads the same feed and needs
no rework; nothing is built for it yet. Prune keeps the newest 10 published dev
releases and deletes their tags with them, and it is deliberately narrow: a
prerelease whose tag carries a `-dev.` identifier is the only thing it will
ever reach.
