package sh.wrustty.app

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.util.Log

/**
 * Tells Rust when the default network changes, so a lost session retries as soon as
 * there's a network, and a live one gets checked rather than waiting minutes for its
 * keepalives to run out. See `network_changed` in session_registry.rs.
 *
 * Once per process, on the application context, because it has to outlive any Activity.
 */
object NetworkWatch {
  private const val TAG = "wRusTTY"
  private var started = false

  @Synchronized
  fun start(context: Context) {
    if (started) return
    started = true
    try {
      val manager = context.applicationContext.getSystemService(ConnectivityManager::class.java)
      manager.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
        // Called for each new default network, which includes a VPN coming up. Moving
        // from one to another is only this: onLost means there's none left.
        override fun onAvailable(network: Network) = networkChanged(true)

        override fun onLost(network: Network) = networkChanged(false)
      })
    } catch (e: RuntimeException) {
      // Sessions still recover this way, on keepalives and the usual retries.
      Log.w(TAG, "couldn't watch the network", e)
    }
  }

  @JvmStatic
  private external fun networkChanged(online: Boolean)
}
