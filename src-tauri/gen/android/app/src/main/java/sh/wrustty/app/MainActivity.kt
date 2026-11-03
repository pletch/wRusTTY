package sh.wrustty.app

import android.graphics.Color
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.WebView
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.Lifecycle

class MainActivity : TauriActivity() {
  companion object {
    /** Outlives this instance, so a recreated Activity starts protected. */
    @Volatile var secureScreen = false
  }

  private var webView: WebView? = null
  private var recreateOnResume = false

  /**
   * The webview's renderer died, by crash or because Android needed the memory. A
   * webview can't outlive its renderer. Recreating the Activity has wry build another
   * one, whose page reattaches to the sessions as after any other loss of the screen.
   */
  fun onRendererGone(view: WebView) {
    (view.parent as? ViewGroup)?.removeView(view)
    view.destroy()
    if (view === webView) webView = null
    // `recreate` is ignored unless the Activity is resumed or paused.
    if (lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) {
      recreate()
    } else {
      recreateOnResume = true
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    // Light icons, because the bars sit over the black set below.
    val dark = SystemBarStyle.dark(Color.TRANSPARENT)
    enableEdgeToEdge(statusBarStyle = dark, navigationBarStyle = dark)
    super.onCreate(savedInstanceState)
    PluginActivityHandover.adopt(this)
    if (secureScreen) window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)

    // Edge to edge, the webview would draw its full height under the status bar,
    // the cutout and the navigation bar, hiding the tab bar and the status strip.
    // Padding the content view keeps the whole layout in the safe area. Counting
    // the keyboard makes the webview shrink when it opens, so the terminal refits
    // and the prompt stays visible.
    val content = findViewById<View>(android.R.id.content)
    content.setBackgroundColor(Color.BLACK)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val safe = insets.getInsets(
        WindowInsetsCompat.Type.systemBars() or
          WindowInsetsCompat.Type.displayCutout() or
          WindowInsetsCompat.Type.ime(),
      )
      view.setPadding(safe.left, safe.top, safe.right, safe.bottom)
      WindowInsetsCompat.CONSUMED
    }
  }

  override fun onStart() {
    super.onStart()
    appVisibilityChanged(true)
  }

  override fun onStop() {
    appVisibilityChanged(false)
    super.onStop()
  }

  /** See vault_autolock.rs. */
  private external fun appVisibilityChanged(visible: Boolean)

  override fun onWebViewCreate(webView: WebView) {
    this.webView = webView
  }

  override fun onResume() {
    super.onResume()
    // What tells Rust a new Activity can take a webview. `Rust.resume` wakes its event
    // loop to act on that.
    activityResumed()
    Rust.resume()
    if (recreateOnResume) {
      recreateOnResume = false
      recreate()
    }
  }

  private external fun activityResumed()

  override fun onDestroy() {
    super.onDestroy()
    // The process may stay for its sessions. A webview left behind would hold its
    // renderer and keep running its page.
    if (!isChangingConfigurations) {
      webView?.let {
        (it.parent as? ViewGroup)?.removeView(it)
        it.destroy()
      }
      webView = null
    }
  }
}
