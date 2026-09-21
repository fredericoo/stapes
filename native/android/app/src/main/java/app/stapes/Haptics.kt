package app.stapes

import android.content.Context
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.webkit.JavascriptInterface

/**
 * The feel of a blow, and the bridge the page reaches it through.
 *
 * **The web side names the event and this decides the waveform.** @see
 * `app/lib/haptics.ts`, and `native/ios/Stapes/Haptics.swift` for the same
 * decision made with the other platform's vocabulary.
 *
 * Installed as `window.StapesNative`. Everything annotated `@JavascriptInterface`
 * here is callable by any script the page runs, so this object stays exactly as
 * wide as a vibration and no wider — which is also why `MainActivity` refuses to
 * navigate off the origin: the bridge is only as trustworthy as the page it is
 * handed to.
 */
class Haptics(context: Context) {
    private val vibrator: Vibrator? = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        val manager = context.getSystemService(VibratorManager::class.java)
        manager?.defaultVibrator
    } else {
        @Suppress("DEPRECATION")
        context.getSystemService(Vibrator::class.java)
    }

    /**
     * Play one.
     *
     * Called on a background thread — that is where the WebView delivers every
     * `@JavascriptInterface` call — which the vibrator is happy with and which
     * is why nothing here touches a view.
     *
     * `intensity` is how much of the body the blow took, 0 to 1, and is floored
     * rather than passed straight through: a buzz too faint to feel reads as
     * broken haptics rather than as a scratch. Devices without amplitude
     * control ignore the number and give their one strength, which is the right
     * degradation.
     */
    @JavascriptInterface
    fun haptic(kind: String, intensity: Double) {
        if (kind != "hit") return
        val device = vibrator ?: return
        if (!device.hasVibrator()) return
        val strength = intensity.coerceIn(0.35, 1.0)
        val amplitude = (strength * 255).toInt().coerceIn(1, 255)
        device.vibrate(VibrationEffect.createOneShot(BLOW_MS, amplitude))
    }

    private companion object {
        /**
         * Short enough to read as an impact rather than as a notification. The
         * platform has no stock "something hit you" effect — `EFFECT_CLICK` is a
         * tick for a control, and the predefined set is about interface
         * feedback rather than about events in a world — so this is the one
         * number the Android side has to choose.
         */
        const val BLOW_MS = 28L
    }
}
