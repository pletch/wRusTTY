package sh.wrustty.app

import android.app.Activity
import android.os.Build
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.util.Base64
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricManager.Authenticators.BIOMETRIC_STRONG
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.fragment.app.FragmentActivity
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

@InvokeArg
class ProtectArgs {
  lateinit var kek: String
}

@InvokeArg
class RecoverArgs {
  lateinit var iv: String
  lateinit var wrappedKek: String
}

/**
 * Biometric unlock for the vault. A Keystore key that can't be used without a
 * strong biometric encrypts the vault's key-encryption key, and only that ciphertext
 * is stored, in the vault file.
 *
 * The cipher goes through `CryptoObject`, so the biometric is what releases the key
 * in hardware, not a check this app could be made to skip. New enrollment invalidates
 * the key, so adding a fingerprint can't open the vault; that leaves the master
 * password, which always works.
 */
@TauriPlugin
class VaultBiometricPlugin(private val activity: Activity) : Plugin(activity) {
  private fun keyStore() = KeyStore.getInstance(KEYSTORE).apply { load(null) }

  @Command
  fun hasKey(invoke: Invoke) {
    val result = JSObject()
    result.put("present", keyStore().containsAlias(ALIAS))
    invoke.resolve(result)
  }

  @Command
  fun forget(invoke: Invoke) {
    try {
      keyStore().deleteEntry(ALIAS)
    } catch (_: Exception) {
      // Nothing to forget.
    }
    invoke.resolve()
  }

  /** Encrypts the key it's given under a new Keystore key, after a biometric. */
  @Command
  fun protect(invoke: Invoke) {
    val args = invoke.parseArgs(ProtectArgs::class.java)
    val problem = unavailableReason()
    if (problem != null) {
      invoke.reject(problem, CODE_UNAVAILABLE)
      return
    }
    val cipher = try {
      Cipher.getInstance(TRANSFORMATION).apply { init(Cipher.ENCRYPT_MODE, generateKey()) }
    } catch (e: Exception) {
      invoke.reject(e.message ?: "couldn't create the key", CODE_UNAVAILABLE)
      return
    }
    prompt(invoke, cipher, "Turn on biometric unlock") { unlocked ->
      val kek = Base64.decode(args.kek, Base64.NO_WRAP)
      val wrapped = unlocked.doFinal(kek)
      kek.fill(0)
      val result = JSObject()
      result.put("iv", Base64.encodeToString(unlocked.iv, Base64.NO_WRAP))
      result.put("wrappedKek", Base64.encodeToString(wrapped, Base64.NO_WRAP))
      result
    }
  }

  /** Decrypts the stored key, after a biometric. */
  @Command
  fun recover(invoke: Invoke) {
    val args = invoke.parseArgs(RecoverArgs::class.java)
    val problem = unavailableReason()
    if (problem != null) {
      invoke.reject(problem, CODE_UNAVAILABLE)
      return
    }
    val key = keyStore().getKey(ALIAS, null) as SecretKey?
    if (key == null) {
      invoke.reject("biometric unlock isn't set up on this device", CODE_INVALIDATED)
      return
    }
    val cipher = try {
      Cipher.getInstance(TRANSFORMATION).apply {
        val iv = Base64.decode(args.iv, Base64.NO_WRAP)
        init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(GCM_TAG_BITS, iv))
      }
    } catch (_: KeyPermanentlyInvalidatedException) {
      invoke.reject(
        "biometrics on this device changed, so unlock with your master password and turn " +
          "biometric unlock on again",
        CODE_INVALIDATED,
      )
      return
    } catch (e: Exception) {
      invoke.reject(e.message ?: "couldn't use the key", CODE_FAILED)
      return
    }
    prompt(invoke, cipher, "Unlock the vault") { unlocked ->
      val kek = unlocked.doFinal(Base64.decode(args.wrappedKek, Base64.NO_WRAP))
      val result = JSObject()
      result.put("kek", Base64.encodeToString(kek, Base64.NO_WRAP))
      kek.fill(0)
      result
    }
  }

  private fun unavailableReason(): String? =
    when (BiometricManager.from(activity).canAuthenticate(BIOMETRIC_STRONG)) {
      BiometricManager.BIOMETRIC_SUCCESS -> null
      BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED ->
        "no fingerprint or face is set up on this device"
      else -> "this device doesn't have biometrics strong enough to protect the vault"
    }

  private fun generateKey(): SecretKey {
    val spec = KeyGenParameterSpec.Builder(
      ALIAS,
      KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT,
    )
      .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
      .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
      .setKeySize(256)
      .setUserAuthenticationRequired(true)
      .setInvalidatedByBiometricEnrollment(true)
    // Zero: every use needs its own biometric, with no window after one.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      spec.setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
    }
    // Unusable while the phone is locked. A key enrolled before this keeps its old rules
    // until biometric unlock is turned off and on again.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      spec.setUnlockedDeviceRequired(true)
    }
    val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE)
    generator.init(spec.build())
    return generator.generateKey()
  }

  private fun prompt(invoke: Invoke, cipher: Cipher, title: String, use: (Cipher) -> JSObject) {
    val host = activity as FragmentActivity
    host.runOnUiThread {
      val callback = object : BiometricPrompt.AuthenticationCallback() {
        override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
          try {
            invoke.resolve(use(result.cryptoObject!!.cipher!!))
          } catch (e: Exception) {
            invoke.reject(e.message ?: "couldn't use the key", CODE_FAILED)
          }
        }

        override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
          val cancelled = errorCode == BiometricPrompt.ERROR_USER_CANCELED ||
            errorCode == BiometricPrompt.ERROR_NEGATIVE_BUTTON ||
            errorCode == BiometricPrompt.ERROR_CANCELED
          invoke.reject(errString.toString(), if (cancelled) CODE_CANCELLED else CODE_FAILED)
        }
        // onAuthenticationFailed is a finger that didn't match: the prompt stays up.
      }
      val info = BiometricPrompt.PromptInfo.Builder()
        .setTitle(title)
        .setNegativeButtonText("Cancel")
        .setAllowedAuthenticators(BIOMETRIC_STRONG)
        .build()
      BiometricPrompt(host, ContextCompat.getMainExecutor(host), callback)
        .authenticate(info, BiometricPrompt.CryptoObject(cipher))
    }
  }

  private companion object {
    const val KEYSTORE = "AndroidKeyStore"
    const val ALIAS = "wrustty-vault-kek"
    const val TRANSFORMATION = "AES/GCM/NoPadding"
    const val GCM_TAG_BITS = 128
    const val CODE_CANCELLED = "cancelled"
    const val CODE_INVALIDATED = "invalidated"
    const val CODE_UNAVAILABLE = "unavailable"
    const val CODE_FAILED = "failed"
  }
}
