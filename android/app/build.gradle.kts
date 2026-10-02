// The app module: the Kotlin shell that hosts core's own pages in a WebView.
//
// core/ui, core/spec and core/fixtures are copied into the APK's assets from
// the repository rather than kept as a second copy in this tree, the way the
// iOS project copies core's directories into its bundle.
//
// The copied layout is core's OWN, deliberately: ui/ and spec/ stay siblings
// because core/ui/motion.js imports ../spec/tokens.json, and a flatter layout
// would break that import with no error anywhere, which is the class of fault
// this repository keeps paying for.

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.azuretek.claw.android"
    compileSdk = 35

    defaultConfig {
        // The applicationId is a Java package name, so it cannot carry the hyphen
        // the iOS bundle id uses (com.azuretek.claw-mobile). The spec owns this
        // value; this line is asserted against it rather than declaring it.
        applicationId = "com.azuretek.claw.android"
        minSdk = 26
        targetSdk = 35
        // The release pipeline passes both, derived from the one base in
        // package.json. The defaults below are the same next version a local
        // build reports, so the APK never carries a second, stale copy of it.
        versionCode = (project.findProperty("versionCode") as String?)?.toInt() ?: 1
        versionName = (project.findProperty("versionName") as String?) ?: "0.0.1"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    // The copied core tree is an asset root, so ui/settings.html, spec/naming.json
    // and fixtures/ keep the layout they have in the repository.
    sourceSets.getByName("main").assets.srcDir(layout.buildDirectory.dir("generated/coreAssets"))

    buildFeatures {
        buildConfig = true
    }

    signingConfigs {
        // The release keystore is a CI secret. Nothing here names a path: the
        // workflow writes the file and sets these variables, and a build with no
        // keystore produces an unsigned APK rather than failing to configure.
        create("release") {
            val storePath = System.getenv("CHELA_ANDROID_KEYSTORE")
            if (!storePath.isNullOrBlank()) {
                storeFile = file(storePath)
                storePassword = System.getenv("CHELA_ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("CHELA_ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("CHELA_ANDROID_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (!System.getenv("CHELA_ANDROID_KEYSTORE").isNullOrBlank()) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

// The specs this client ships, named ONE BY ONE rather than copied wholesale.
//
// Both reasons are the inventory in core/test/specs.test.js doing its job: it
// asserts that each client bundles exactly what it says it does, and it reads THIS
// list as the Android side authority the way it reads mobile/project.yml for iOS.
// A blanket copy would ship specs this client never reads and would leave that
// assertion with nothing to hold.
val androidSpecs = listOf(
    "naming.json",     // the product name, read at runtime by Naming.kt
    "settings.json",   // the settings surface split, read by HostBridge for its command vocabulary
    "tokens.json",     // imported by ui/motion.js, so the page cannot paint without it
)

// Copy the shared tree beside the app before the asset merger runs, so the APK
// carries the one owner of every page, spec and fixture rather than a copy that
// can drift.
val copyCore by tasks.registering(Copy::class) {
    from(rootProject.file("../core/ui")) { into("ui") }
    androidSpecs.forEach { name ->
        from(rootProject.file("../core/spec/$name")) { into("spec") }
    }
    // Every fixture, because they are the golden pairs the parity tests compare
    // against rather than content a client reads at runtime.
    from(rootProject.file("../core/fixtures")) { into("fixtures") }
    into(layout.buildDirectory.dir("generated/coreAssets"))
}

tasks.matching { it.name.startsWith("merge") && it.name.endsWith("Assets") }.configureEach { dependsOn(copyCore) }

// Every task with lint in its name reads the same copied assets, so every one
// waits for the copy. A name prefix is not enough, because AGP's generated lint
// model tasks are spelled differently, so the match is on the whole name, case
// insensitively.
tasks.matching { it.name.lowercase().contains("lint") }.configureEach { dependsOn(copyCore) }

dependencies {
    // The web view host and its asset loader.
    implementation("androidx.webkit:webkit:1.12.1")

    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.2.1")
    androidTestImplementation("androidx.test:runner:1.6.2")
    androidTestImplementation("androidx.test:rules:1.6.1")
}
