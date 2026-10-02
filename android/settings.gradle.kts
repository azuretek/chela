// The Gradle build for the Android shell. This file names the one module.
//
// The project files here are source rather than generated output: Gradle reads
// them directly, so unlike the iOS side there is no generator and no committed
// binary project file that can drift from what the build actually does.

pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}

rootProject.name = "Chela"
include(":app")
