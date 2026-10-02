#!/usr/bin/env node
// The Android platform's entrypoint from the ROOT scripts.
//
// Why this exists. android/ is a first-class peer of core, desktop and mobile,
// but it is Kotlin and Gradle rather than JavaScript, so it is not a pnpm
// workspace member. The root scripts fan out to every platform; this is how the
// Android leg is reached from them, running Android's OWN tooling rather than
// pretending it is a JS package:
//
//   node scripts/android.mjs lint     the Gradle lint task
//   node scripts/android.mjs test     the JVM unit tests, which hold the parity
//                                     suite against core/fixtures/
//   node scripts/android.mjs build    assembleDebug
//
// It is deliberately forgiving on a host that cannot build for Android: a
// machine with no Android SDK SKIPS with a named reason rather than failing, the
// same rule scripts/mobile.mjs follows and for the same reason, because most of
// our hosts have no SDK and a checkout with no Java has no business failing the
// whole root lint on a platform it cannot touch. The real Android gate is the
// android workflow on Linux runners, which has the SDK.
//
// The difference from mobile is worth stating: iOS is Mac-only and cannot
// offload, where Android builds on Linux, so CI is the ordinary path here rather
// than a fallback.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..");
const ANDROID = path.join(ROOT, "android");

const task = process.argv[2];

function have(bin) {
  const r = spawnSync(process.platform === "win32" ? "where" : "which", [bin], { stdio: "ignore" });
  return r.status === 0;
}

function skip(reason) {
  // A SKIP is not a pass. It is named so a green root script cannot hide a
  // platform that was never exercised.
  //
  // Where the caller has said the tools must be there, a skip is a FAILURE: the
  // CI job that sets this installs the SDK on purpose, so a missing one is a
  // broken job rather than a host that cannot build for Android.
  if (process.env.CHELA_REQUIRE_ANDROID_TOOLS === "1") {
    console.log(`android:${task}: FAILED, ${reason}, and CHELA_REQUIRE_ANDROID_TOOLS says this may not skip`);
    process.exit(1);
  }
  console.log(`android:${task}: SKIPPED, ${reason}`);
  process.exit(0);
}

function sdkRoot() {
  return process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || "";
}

/**
 * Whether this host can run the Android build at all.
 *
 * The SDK is what makes the difference: a Java runtime alone cannot resolve the
 * platform and the build tools. The wrapper is checked too, because a checkout
 * without it cannot bootstrap Gradle and the failure would read as a build
 * fault rather than a missing file.
 */
function requireToolchain() {
  const wrapper = path.join(ANDROID, process.platform === "win32" ? "gradlew.bat" : "gradlew");
  if (!fs.existsSync(wrapper)) skip("android/gradlew is missing, so Gradle cannot bootstrap");
  if (!have("java")) skip("no Java runtime is installed, and the Android build needs JDK 17");
  const sdk = sdkRoot();
  if (!sdk) skip("ANDROID_HOME and ANDROID_SDK_ROOT are both unset, so there is no Android SDK");
  if (!fs.existsSync(sdk)) skip(`the Android SDK path does not exist: ${sdk}`);
}

function gradle(args) {
  const wrapper = path.join(ANDROID, process.platform === "win32" ? "gradlew.bat" : "gradlew");
  console.log(`android:${task}: gradlew ${args.join(" ")}`);
  const r = spawnSync(wrapper, args, { cwd: ANDROID, stdio: "inherit" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

requireToolchain();

switch (task) {
  case "lint":
    gradle(["--no-daemon", ":app:lintDebug"]);
    break;
  case "test":
    gradle(["--no-daemon", ":app:testDebugUnitTest"]);
    break;
  case "build":
    gradle(["--no-daemon", ":app:assembleDebug"]);
    break;
  default:
    console.error(`android.mjs: unknown task '${task}'. Use lint, test, or build.`);
    process.exit(2);
}
