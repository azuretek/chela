package com.azuretek.claw.android

import android.content.res.AssetManager

/**
 * The one loader for every spec the app ships.
 *
 * core/spec/*.json is the source of truth for the values and the programs both
 * clients use, and this client bundles the file rather than porting it, so the
 * shipped copy IS the one owner. A Kotlin copy of a script would be a second copy
 * of the program in another language, which is the drift the shared file exists
 * to prevent.
 */
object BundledSpec {
    fun text(assets: AssetManager, path: String): String =
        assets.open(path).bufferedReader().use { it.readText() }
}
