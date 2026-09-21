package app.stapes

import android.net.Uri

/**
 * Where the game is.
 *
 * **The shell holds no copy of the game.** It loads this origin and shows
 * whatever comes back, which is what keeps the session cookie first-party, the
 * socket same-origin and the API base URL absent — see `docs/notes.md`, "The
 * native shells load the server, they do not carry the game".
 *
 * The host is written down twice and both copies have to agree: here, and in
 * the `android:host` of the deep link filter in `AndroidManifest.xml`.
 */
object Config {
    const val ORIGIN = "https://stapes.example.com"

    /** The one host this shell will navigate to. */
    val HOST: String = Uri.parse(ORIGIN).host ?: ""

    /**
     * Appended to the WebView user agent, so the server and its logs can tell
     * an app session from a tab.
     */
    const val USER_AGENT_SUFFIX = "StapesAndroid"
}
