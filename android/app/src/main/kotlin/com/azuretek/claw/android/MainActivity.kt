package com.azuretek.claw.android

import android.app.Activity
import android.graphics.Bitmap
import android.graphics.Color
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.ViewGroup.LayoutParams.MATCH_PARENT
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature

/**
 * The app's one screen: one of core's own pages, hosted in a WebView, under a
 * cover until the page has painted.
 *
 * The shell supplies a web view, secure storage and one host bridge, and nothing
 * else. Every screen and rule is in core/, which the build copies into the APK's
 * assets, so the shipped page IS the repository's page.
 *
 * The entry page here is the app's own About surface. It is a real Chela screen
 * that paints without host data, which is what makes it the right thing to boot
 * for a shell whose gateway flow has not landed yet. The gateway entry replaces
 * it when the Control UI host does.
 */
class MainActivity : Activity() {

    companion object {
        /** The asset loader's own origin, so no network is involved in loading the page. */
        const val ASSET_ROOT = "/assets/"
        const val START_PAGE = "ui/about.html"
        const val START_URL = "https://appassets.androidplatform.net" + ASSET_ROOT + START_PAGE
    }

    private lateinit var webView: WebView
    private lateinit var cover: LinearLayout
    private lateinit var coverMessage: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Read from the bundled spec rather than declared here, so the product name
        // has one owner. Falls back to the class name only if the spec is missing,
        // which is a build fault rather than a state to design for.
        val product = Naming.product(assets).ifEmpty { "Chela" }
        val bridge = HostBridge(this, SecureStore(this), versionName(), product, HostBridge.commandNames(assets))

        webView = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            addJavascriptInterface(bridge, HostBridge.INTERFACE_NAME)
            webViewClient = ShellClient()
        }

        coverMessage = TextView(this).apply {
            text = product
            gravity = Gravity.CENTER
        }
        cover = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER
            setBackgroundColor(Color.WHITE)
            addView(ProgressBar(this@MainActivity))
            addView(coverMessage)
        }

        val root = FrameLayout(this)
        root.addView(webView, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        root.addView(cover, FrameLayout.LayoutParams(MATCH_PARENT, MATCH_PARENT))
        setContentView(root)

        installHostAtDocumentStart()
        webView.loadUrl(START_URL)
    }

    /**
     * Install window.clawSettings before the page's own script runs.
     *
     * DOCUMENT_START_SCRIPT is the Android equivalent of the WKUserScript the iOS
     * client installs, and it is the only place this port is not mechanical. The
     * fallback injects at onPageStarted, which is weaker: the page can already have
     * run its first render, which is exactly why the page throws when it finds no
     * host rather than limping on. Whether the strong path is available is decided
     * by the WebView's version and not by minSdk, because Android's WebView updates
     * independently of the operating system.
     */
    private fun installHostAtDocumentStart() {
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            WebViewCompat.addDocumentStartJavaScript(webView, HostBridge.injectedScript, setOf("*"))
        }
    }

    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }

    private fun fail(message: String) {
        cover.visibility = View.VISIBLE
        coverMessage.text = message
    }

    private fun versionName(): String = try {
        packageManager.getPackageInfo(packageName, 0).versionName ?: "0"
    } catch (e: Exception) {
        "0"
    }

    /** The web view host: one asset loader and one delegate for the page's lifecycle. */
    private inner class ShellClient : WebViewClient() {
        private val loader = WebViewAssetLoader.Builder()
            .addPathHandler(ASSET_ROOT, WebViewAssetLoader.AssetsPathHandler(this@MainActivity))
            .build()

        override fun shouldInterceptRequest(view: WebView?, request: WebResourceRequest?): WebResourceResponse? =
            if (request == null) null else loader.shouldInterceptRequest(request.url)

        override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
            // The fallback path only. Where the document-start feature exists the
            // script is already installed and this is a no-op, because the injected
            // script returns early when window.clawSettings is already there.
            if (!WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
                view?.evaluateJavascript(HostBridge.injectedScript, null)
            }
        }

        override fun onPageFinished(view: WebView?, url: String?) {
            cover.visibility = View.GONE
        }

        override fun onReceivedError(view: WebView?, request: WebResourceRequest?, error: WebResourceError?) {
            if (request?.isForMainFrame == true) {
                fail(error?.description?.toString() ?: "the page did not load")
            }
        }
    }
}
