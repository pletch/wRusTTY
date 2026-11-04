package sh.wrustty.app

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.util.Log
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

@InvokeArg
class SetSessionsArgs {
  var count: Int = 0
}

/** Starts and stops [SessionKeepAliveService] as sessions open and close. */
@TauriPlugin
class KeepAlivePlugin(private val activity: Activity) : Plugin(activity) {
  private var askedForNotifications = false

  @Command
  fun setSessions(invoke: Invoke) {
    val count = invoke.parseArgs(SetSessionsArgs::class.java).count
    val intent = Intent(activity, SessionKeepAliveService::class.java)
    try {
      if (count > 0) {
        askForNotifications()
        intent.putExtra(SessionKeepAliveService.EXTRA_COUNT, count)
        ContextCompat.startForegroundService(activity, intent)
      } else {
        activity.stopService(intent)
      }
      Log.i(TAG, "sessions=$count")
      invoke.resolve()
    } catch (e: Exception) {
      // Android refuses to start one from the background. The sessions still
      // work; they just won't survive this time in the background.
      Log.w(TAG, "couldn't update the service for $count sessions", e)
      invoke.reject(e.message)
    }
  }

  /** To the background rather than finished, so the sessions carry on. */
  @Command
  fun moveToBack(invoke: Invoke) {
    activity.moveTaskToBack(true)
    invoke.resolve()
  }

  /**
   * Android 13 and up hides the notification without this. The service runs
   * either way, so declining costs only the visible reminder.
   */
  private fun askForNotifications() {
    if (askedForNotifications || Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
    askedForNotifications = true
    val permission = Manifest.permission.POST_NOTIFICATIONS
    if (ContextCompat.checkSelfPermission(activity, permission) != PackageManager.PERMISSION_GRANTED) {
      ActivityCompat.requestPermissions(activity, arrayOf(permission), 4101)
    }
  }

  private companion object {
    const val TAG = "wRusTTY/KeepAlive"
  }
}
