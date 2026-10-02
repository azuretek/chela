package com.azuretek.claw.android

import android.content.Context
import android.webkit.JavascriptInterface
import org.json.JSONObject

/**
 * The shell's half of the contract core/ui/settings.js talks to.
 *
 * The page calls window.clawSettings.invoke(command, args) and .on(event, handler).
 * This object answers the commands, and MainActivity pushes the events. One door
 * with named commands rather than a method per action, because the same page runs
 * against a preload script on the desktop and a message handler on iOS, and named
 * methods would be a third copy of one contract.
 *
 * The command names are read from the bundled core/spec/settings.json rather than
 * written here, so the vocabulary has one owner and a command the page can reach
 * that is not implemented is a named refusal rather than a button that does
 * nothing silently.
 */
class HostBridge(
    private val context: Context,
    private val store: SecureStore,
    private val version: String,
    private val product: String,
    private val commands: Set<String>,
) {

    companion object {
        const val INTERFACE_NAME = "chelaNative"

        /** The command names core/spec/settings.json gives this client. */
        fun commandNames(assets: android.content.res.AssetManager): Set<String> = try {
            val spec = JSONObject(BundledSpec.text(assets, "spec/settings.json"))
            val clients = spec.optJSONObject("clients")
            val declared = clients?.optJSONObject("android")?.optJSONArray("commands")
            if (declared != null) {
                (0 until declared.length()).map { declared.optString(it) }.filter { it.isNotEmpty() }.toSet()
            } else {
                // Android is not in the spec yet, so nothing is declared and nothing
                // is answered. An empty vocabulary refuses every command by name
                // rather than pretending to implement one.
                emptySet()
            }
        } catch (e: Exception) {
            emptySet()
        }

        /**
         * The document-start script that installs window.clawSettings over the
         * JavaScript interface. It must be installed before the page boots,
         * because the page resolves its host during its own first render and
         * throws if there is none.
         */
        val injectedScript: String = """
            (function () {
              if (window.clawSettings) { return; }
              var handlers = {};
              window.clawSettings = {
                invoke: function (command, args) {
                  return new Promise(function (resolve, reject) {
                    var payload;
                    try {
                      payload = JSON.parse(window.$INTERFACE_NAME.invoke(String(command), JSON.stringify(args || {})));
                    } catch (e) {
                      reject(new Error(String(e && e.message ? e.message : e)));
                      return;
                    }
                    if (payload && payload.ok) { resolve(payload.value); }
                    else { reject(new Error(String(payload && payload.value))); }
                  });
                },
                on: function (event, handler) {
                  if (!handlers[event]) { handlers[event] = []; }
                  handlers[event].push(handler);
                  return function () {
                    handlers[event] = (handlers[event] || []).filter(function (h) { return h !== handler; });
                  };
                },
                /* The host's own door for pushing an event. Never called by the page. */
                __emit: function (event, payload) {
                  (handlers[event] || []).forEach(function (h) {
                    try { h(payload); } catch (e) {}
                  });
                }
              };
            })();
        """.trimIndent()
    }

    @JavascriptInterface
    fun invoke(command: String, argsJson: String): String {
        val args = try { JSONObject(argsJson) } catch (e: Exception) { JSONObject() }
        val result = try {
            dispatch(command, args)
        } catch (e: Exception) {
            failure(e.message ?: "bridge failure")
        }
        return result.toString()
    }

    private fun dispatch(command: String, args: JSONObject): JSONObject {
        if (command !in commands) return failure("this client does not implement the command: " + command)
        return failure("this client does not implement the command yet: " + command)
    }

    private fun success(value: Any): JSONObject = JSONObject().put("ok", true).put("value", value)

    private fun failure(value: Any): JSONObject = JSONObject().put("ok", false).put("value", value)
}
