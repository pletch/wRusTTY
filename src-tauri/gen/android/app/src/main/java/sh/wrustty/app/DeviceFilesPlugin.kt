package sh.wrustty.app

import android.app.Activity
import android.net.Uri
import android.util.Base64
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.ByteArrayOutputStream

@InvokeArg
class ReadUriArgs {
  lateinit var uri: String
}

@InvokeArg
class WriteUriArgs {
  lateinit var uri: String
  lateinit var base64: String
}

/**
 * The file picker hands back `content://` links, which only Android can open.
 * For small files the user picked: a vault export or an SSH key.
 */
@TauriPlugin
class DeviceFilesPlugin(private val activity: Activity) : Plugin(activity) {
  @Command
  fun read(invoke: Invoke) {
    val uri = Uri.parse(invoke.parseArgs(ReadUriArgs::class.java).uri)
    try {
      val stream = activity.contentResolver.openInputStream(uri)
        ?: throw IllegalStateException("the file couldn't be opened")
      val out = ByteArrayOutputStream()
      stream.use { input ->
        val buffer = ByteArray(16 * 1024)
        while (true) {
          val read = input.read(buffer)
          if (read < 0) break
          out.write(buffer, 0, read)
          if (out.size() > MAX_BYTES) throw IllegalStateException("that file is too large")
        }
      }
      val bytes = out.toByteArray()
      val result = JSObject()
      result.put("base64", Base64.encodeToString(bytes, Base64.NO_WRAP))
      bytes.fill(0)
      invoke.resolve(result)
    } catch (e: Exception) {
      invoke.reject(e.message ?: "the file couldn't be read")
    }
  }

  @Command
  fun write(invoke: Invoke) {
    val args = invoke.parseArgs(WriteUriArgs::class.java)
    try {
      val bytes = Base64.decode(args.base64, Base64.NO_WRAP)
      // "wt" truncates, so a shorter file doesn't keep the old one's tail.
      val stream = activity.contentResolver.openOutputStream(Uri.parse(args.uri), "wt")
        ?: throw IllegalStateException("the file couldn't be opened for writing")
      stream.use { it.write(bytes) }
      invoke.resolve()
    } catch (e: Exception) {
      invoke.reject(e.message ?: "the file couldn't be written")
    }
  }

  private companion object {
    const val MAX_BYTES = 16 * 1024 * 1024
  }
}
