package sh.wrustty.app

import android.text.InputType
import android.view.inputmethod.EditorInfo

/**
 * What the app's text fields tell the keyboard about themselves. `RustWebView` calls
 * this for every field that opens one; see `WRY_RUSTWEBVIEW_CLASS_EXTENSION` in
 * `.cargo/config.toml`.
 *
 * A terminal can't know what it's being sent. A `sudo` password goes through the same
 * hidden field as a command, and to a keyboard that's ordinary text: it shows each
 * letter in the suggestion strip and may learn the word. So nothing here gets
 * suggestions or is learned from. HTML attributes only ask, and keyboards ignore them.
 *
 * "Visible password" is what makes keyboards honor it, as Termux relies on too. It
 * also means no autocorrect, no capitals and no composing a word before sending it.
 * It costs swipe typing, which isn't much use for commands anyway.
 */
object TextEntryHints {
  fun apply(info: EditorInfo) {
    // Whatever a field is, nothing typed into it goes into the keyboard's memory.
    info.imeOptions = info.imeOptions or EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING

    val type = info.inputType
    if (type and InputType.TYPE_MASK_CLASS != InputType.TYPE_CLASS_TEXT) return
    when (type and InputType.TYPE_MASK_VARIATION) {
      // Already private, and masked: leave them that way.
      InputType.TYPE_TEXT_VARIATION_PASSWORD,
      InputType.TYPE_TEXT_VARIATION_WEB_PASSWORD -> return
    }
    info.inputType = InputType.TYPE_CLASS_TEXT or
      InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD or
      InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS or
      (type and InputType.TYPE_TEXT_FLAG_MULTI_LINE)
  }
}
