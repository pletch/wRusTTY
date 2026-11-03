package sh.wrustty.app

import android.app.Activity
import android.view.WindowManager
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

@InvokeArg
class SetSecureArgs {
  var on: Boolean = false
}

/** The setting that keeps the terminal out of screenshots and screen sharing. */
@TauriPlugin
class ScreenSecurityPlugin(private val activity: Activity) : Plugin(activity) {
  @Command
  fun setSecure(invoke: Invoke) {
    val on = invoke.parseArgs(SetSecureArgs::class.java).on
    MainActivity.secureScreen = on
    activity.runOnUiThread {
      if (on) {
        activity.window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
      } else {
        activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
      }
      invoke.resolve()
    }
  }
}
