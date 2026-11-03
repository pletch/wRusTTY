package sh.wrustty.app

import android.graphics.Color
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.activity.SystemBarStyle
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  private var webView: WebView? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    // Light icons, because the bars sit over the black set below.
    val dark = SystemBarStyle.dark(Color.TRANSPARENT)
    enableEdgeToEdge(statusBarStyle = dark, navigationBarStyle = dark)
    super.onCreate(savedInstanceState)
    PluginActivityHandover.adopt(this)

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

  override fun onWebViewCreate(webView: WebView) {
    this.webView = webView
  }

  override fun onResume() {
    super.onResume()
    // What tells Rust a new Activity can take a webview. `Rust.resume` wakes its event
    // loop to act on that.
    activityResumed()
    Rust.resume()
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
