package com.azuretek.claw.android

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * The gateway token and password, encrypted with a key the Android Keystore holds
 * and never exports.
 *
 * This is the analogue of the iOS Keychain store. One difference is deliberate and
 * recorded because it changes behaviour: a Keystore key does NOT survive an
 * uninstall where a Keychain item does, so a reinstall regenerates the device
 * identity unless that is solved deliberately. See the plan's risks.
 *
 * Write-only from the page: a value can be set or cleared, and the page can learn
 * whether one exists, but it can never read one back.
 */
class SecureStore(private val context: Context) {

    companion object {
        private const val KEYSTORE = "AndroidKeyStore"
        private const val KEY_ALIAS = "chela.secure.v1"
        private const val PREFS = "chela.secure"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val TAG_BITS = 128
    }

    private val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** Storage keys are lower-case words joined by dots, the desktop's own shape. */
    fun has(key: String): Boolean = prefs.contains(key)

    fun set(key: String, value: String): Boolean {
        // A BLOCK body, not an expression body, because the empty case returns
        // early and Kotlin prohibits `return` inside `= try { ... }`. The compiler
        // says so plainly and CI caught it: returns are prohibited for functions
        // with an expression body. An empty value clears the key rather than
        // storing nothing, which is what the page means when it sends one.
        if (value.isEmpty()) return clear(key)
        return try {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.ENCRYPT_MODE, secretKey())
            val body = Base64.encodeToString(cipher.doFinal(value.toByteArray(Charsets.UTF_8)), Base64.NO_WRAP)
            val iv = Base64.encodeToString(cipher.iv, Base64.NO_WRAP)
            prefs.edit().putString(key + ".body", body).putString(key + ".iv", iv).apply()
            true
        } catch (e: Exception) {
            false
        }
    }

    fun clear(key: String): Boolean {
        prefs.edit().remove(key + ".body").remove(key + ".iv").apply()
        return true
    }

    private fun secretKey(): SecretKey {
        val ks = KeyStore.getInstance(KEYSTORE).apply { load(null) }
        (ks.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry)?.let { return it.secretKey }
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .build(),
        )
        return generator.generateKey()
    }
}
