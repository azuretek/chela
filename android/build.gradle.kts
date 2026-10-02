// The root build: the plugin versions, and nothing else. Each module applies
// what it needs.

plugins {
    id("com.android.application") version "8.7.3" apply false
    id("org.jetbrains.kotlin.android") version "2.0.21" apply false
}
