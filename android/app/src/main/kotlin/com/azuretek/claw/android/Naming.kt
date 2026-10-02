package com.azuretek.claw.android

import android.content.res.AssetManager
import org.json.JSONObject

/**
 * What this product is called, read from the bundled core/spec/naming.json.
 *
 * The spec is the one owner of the product name, so nothing a person reads is
 * written into Kotlin. This client reads the file at runtime rather than mirroring
 * the value, which is the shape every spec is moving to.
 */
object Naming {
    fun product(assets: AssetManager): String = try {
        JSONObject(BundledSpec.text(assets, "spec/naming.json")).optString("product")
    } catch (e: Exception) {
        ""
    }
}
