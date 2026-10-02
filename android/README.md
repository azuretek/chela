# Chela for Android (chela-android)

The native Android shell for the OpenClaw Control UI: a Kotlin app hosting
core's own pages in a `WebView`, with the shared rules carried rather than
ported, the gateway token in the Android Keystore, and a host bridge that answers
the same command vocabulary the desktop and iOS clients answer.

Status: **in development**. This directory is the shell, its pipeline and a
debug APK that builds and boots. The design and the phased plan live in the
Projects database, and this directory fills in as the phases land.

## Why a shell and not a port

The desktop client is Electron, which cannot be cross compiled to Android: there
is no Android target and the architecture has no path there. Android is therefore
a third interface, not a build flag.

What this tree does NOT reimplement, because `core/` already owns it:

- **The pages themselves.** `core/ui/settings.html`, `about.html`, `pairing.html`,
  `loading.html` and their stylesheets and scripts are copied into the APK's
  assets by the build, so the shipped page IS the repository's page. One
  implementation of every surface, rendered by three clients.
- **The specs.** `core/spec/*.json` is bundled and read at runtime through one
  loader, `BundledSpec`. Nothing is mirrored into Kotlin constants, which is the
  rule `core/test/specs.test.js` enforces with an empty `MIRRORED` map: a Kotlin
  copy of a script would be a second copy of the program in another language.
- **The fixtures.** `core/fixtures/*.json` ships with the app so the parity tests
  on this side run against the same golden pairs as the other two clients.

What is native, because it has no cross-platform form:

- The web view host (`WebView` and a `WebViewAssetLoader` instead of a
  `WKWebView` or an Electron `WebContentsView`).
- Per-gateway secrets in the Android Keystore, write-only from the page.
- The one host bridge, reached over a `JavascriptInterface`.

## The asset layout is core's own, deliberately

The copied tree keeps `ui/` and `spec/` as siblings, because
`core/ui/motion.js` imports `../spec/tokens.json`. A flatter layout would break
that import with no error anywhere, which is the class of fault this repository
keeps paying for.

## Building

From the repo root, the same three verbs every platform answers:

```
node scripts/android.mjs build    # :app:assembleDebug
node scripts/android.mjs test     # the JVM unit tests, including the parity suite
node scripts/android.mjs lint     # the Gradle lint task
```

They are reached from the root fan out too, so `pnpm run lint`, `pnpm run test`
and `pnpm run build` all include Android.

**On a host with no Android SDK the leg SKIPS BY NAME rather than failing**,
because most of our hosts have none and a checkout with no Java has no business
failing a platform it cannot touch. The reason is printed, so a green root script
cannot hide a platform that was never exercised. Where the caller knows the tools
must be present, `CHELA_REQUIRE_ANDROID_TOOLS=1` turns that skip into a failure:
the CI job sets it, so a missing SDK there is a broken job rather than a host
that cannot build for Android.

From this directory, Gradle directly:

```
./gradlew :app:assembleDebug
./gradlew :app:testDebugUnitTest
```

The wrapper is committed, so no Gradle install is required. The instrumented
tests need a running emulator or a device:

```
./gradlew :app:connectedDebugAndroidTest
```

## The pipeline

`.github/workflows/android.yml` is the Android half. On every pull request it
builds the debug app, boots it in an emulator, captures
`android/proof/android-boot.png` and runs the instrumented tests. A shell that
only compiles is not a shell that runs, so the boot is the acceptance rather than
the compile.

**It has no publish job yet, on purpose.** Android has no release artifact until
the release gate is generalised for a third pipeline, and a publish job that
nothing gates is precisely the fault the gate exists to prevent: a release
published from a commit whose other platform was red. The signing job lands with
that gate, not before it.

## Where Android runs

CI runs the emulator on a standard GitHub Linux runner, which carries the
virtualization it needs. **No household host has an Android toolchain**, so this
workflow is the gate rather than a fallback for one, and a local build loop is a
host to be provisioned before it can be promised.

## Layout

| Path | What it is |
|---|---|
| `app/` | The app module: the activity and its web view host, the host bridge, the Keystore store and the spec loader. |
| `app/src/test/` | JVM unit tests, including the parity suite against `core/fixtures/`. |
| `app/src/androidTest/` | Instrumented tests, run in the emulator. |
| `scripts/boot-proof.sh` | The capture the pipeline runs: build, install, launch, screenshot. |
| `gradlew`, `gradle/wrapper/` | The wrapper a builder needs, so no Gradle install is required. |
