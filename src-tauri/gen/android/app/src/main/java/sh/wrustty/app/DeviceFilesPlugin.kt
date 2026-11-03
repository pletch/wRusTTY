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
import android.os.ParcelFileDescriptor
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import java.io.ByteArrayOutputStream
import java.util.concurrent.ConcurrentHashMap

@InvokeArg
class ReadUriArgs {
  lateinit var uri: String
}

@InvokeArg
class OpenUriArgs {
  lateinit var uri: String
  lateinit var mode: String
}

@InvokeArg
class CloseWriteArgs {
  var fd: Int = -1
  var error: String? = null
}

@InvokeArg
class WriteUriArgs {
  lateinit var uri: String
  lateinit var base64: String
}

/**
 * The file picker hands back `content://` links, which only Android can open.
 * `read` and `write` are for small files: a vault export or an SSH key. A transfer of
 * any size takes a file descriptor from `open` and streams it in Rust.
 *
 * What's behind a link can be a cloud file that has to download first, so the newer
 * commands stay off the thread they're called on.
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

  /** For reading. The descriptor is detached, for Rust to close. */
  @Command
  fun open(invoke: Invoke) {
    val args = invoke.parseArgs(OpenUriArgs::class.java)
    Thread {
      try {
        val descriptor = activity.contentResolver.openFileDescriptor(Uri.parse(args.uri), args.mode)
          ?: throw IllegalStateException("the file couldn't be opened")
        val result = JSObject()
        result.put("fd", descriptor.detachFd())
        invoke.resolve(result)
      } catch (e: Exception) {
        invoke.reject(e.message ?: "the file couldn't be opened")
      }
    }.start()
  }

  /**
   * For writing, this keeps the descriptor and lends out its number, until `closeWrite`.
   * A provider like Google Drive waits to hear from this end's close that the file is
   * whole. Detached, it hears that the descriptor was detached, and keeps nothing.
   */
  @Command
  fun openWrite(invoke: Invoke) {
    val args = invoke.parseArgs(OpenUriArgs::class.java)
    Thread {
      try {
        val descriptor = activity.contentResolver.openFileDescriptor(Uri.parse(args.uri), args.mode)
          ?: throw IllegalStateException("the file couldn't be opened for writing")
        writing[descriptor.fd] = descriptor
        val result = JSObject()
        result.put("fd", descriptor.fd)
        invoke.resolve(result)
      } catch (e: Exception) {
        invoke.reject(e.message ?: "the file couldn't be opened for writing")
      }
    }.start()
  }

  @Command
  fun closeWrite(invoke: Invoke) {
    val args = invoke.parseArgs(CloseWriteArgs::class.java)
    Thread {
      try {
        val descriptor = writing.remove(args.fd)
          ?: throw IllegalStateException("that file isn't open")
        val error = args.error
        if (error == null) descriptor.close() else descriptor.closeWithError(error)
        invoke.resolve()
      } catch (e: Exception) {
        invoke.reject(e.message ?: "the file couldn't be finished")
      }
    }.start()
  }

  @Command
  fun describe(invoke: Invoke) {
    val uri = Uri.parse(invoke.parseArgs(ReadUriArgs::class.java).uri)
    Thread {
      try {
        val columns = arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE)
        val result = JSObject()
        activity.contentResolver.query(uri, columns, null, null, null)?.use { row ->
          if (row.moveToFirst()) {
            if (!row.isNull(0)) result.put("name", row.getString(0))
            if (!row.isNull(1)) result.put("size", row.getLong(1))
          }
        }
        if (!result.has("name")) throw IllegalStateException("the file has no name")
        invoke.resolve(result)
      } catch (e: Exception) {
        invoke.reject(e.message ?: "the file couldn't be read")
      }
    }.start()
  }

  /** The empty document a save dialog creates, when the download is canceled. */
  @Command
  fun remove(invoke: Invoke) {
    val uri = Uri.parse(invoke.parseArgs(ReadUriArgs::class.java).uri)
    Thread {
      try {
        DocumentsContract.deleteDocument(activity.contentResolver, uri)
        invoke.resolve()
      } catch (e: Exception) {
        invoke.reject(e.message ?: "the file couldn't be removed")
      }
    }.start()
  }

  private companion object {
    const val MAX_BYTES = 16 * 1024 * 1024

    /** Outlives this instance, which is rebuilt along with the Activity. */
    val writing = ConcurrentHashMap<Int, ParcelFileDescriptor>()
  }
}
