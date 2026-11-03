package sh.wrustty.app

import android.app.Activity
import android.util.Log
import androidx.appcompat.app.AppCompatActivity
import app.tauri.plugin.Plugin
import app.tauri.plugin.PluginHandle
import app.tauri.plugin.PluginManager

/**
 * Moves Tauri's plugins to a new Activity in the same process, which happens when the
 * process stays for its sessions (see session_attach.rs).
 *
 * `PluginManager` lives as long as the process but only ever takes the first Activity,
 * and each plugin holds the Activity it was built with. Left alone, a biometric prompt
 * or a file picker would open on a destroyed Activity. Nothing public changes either,
 * so this reaches in by reflection, and is pinned by the Tauri version in gen/android.
 *
 * Must run during `onCreate`, because the manager registers for activity results.
 */
object PluginActivityHandover {
  private const val TAG = "wRusTTY"

  fun adopt(activity: AppCompatActivity) {
    if (PluginManager.activity === activity) return
    try {
      // Clearing the field is what lets `onActivityCreate` run again.
      val manager = PluginManager::class.java
      manager.getDeclaredField("activity").apply { isAccessible = true }.set(PluginManager, null)
      PluginManager.onActivityCreate(activity)

      val plugins = manager.getDeclaredField("plugins").apply { isAccessible = true }
        .get(PluginManager) as Map<*, *>
      for (handle in plugins.values.toList()) {
        rebuild(handle as PluginHandle, activity)
      }
    } catch (e: ReflectiveOperationException) {
      Log.e(TAG, "couldn't hand plugins to the new activity", e)
    }
  }

  private fun rebuild(handle: PluginHandle, activity: Activity) {
    try {
      val plugin = handle.instance.javaClass
        .getConstructor(Activity::class.java)
        .newInstance(activity) as Plugin
      // No webview yet. `onWebViewCreated` loads it when there is one.
      PluginManager.load(null, handle.name, plugin, handle.config)
    } catch (e: ReflectiveOperationException) {
      Log.e(TAG, "couldn't rebuild plugin ${handle.name}", e)
    }
  }
}
