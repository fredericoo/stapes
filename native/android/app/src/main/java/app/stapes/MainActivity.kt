package app.stapes

import android.annotation.SuppressLint
import android.content.Intent
import android.graphics.Color
import android.os.Bundle
import android.view.View
import android.webkit.CookieManager
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.OnBackPressedCallback
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import app.stapes.databinding.ActivityMainBinding

/**
 * The whole interface: a WebView, and the one thing that can be in front of it.
 *
 * **The page is given the full display and is not inset.** `app/root.tsx` sets
 * `viewport-fit=cover` and insets its own chrome with `env(safe-area-inset-*)`,
 * so this draws edge to edge and leaves the gesture bar and the cutout to the
 * page. `setDecorFitsSystemWindows(false)` here and `shortEdges` in the theme
 * are the two halves of that.
 */
class MainActivity : AppCompatActivity() {
    private lateinit var binding: ActivityMainBinding

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        WindowCompat.setDecorFitsSystemWindows(window, false)
        // The page paints behind both bars in `#1a1a1a`, so the system's own
        // scrims would be a second, slightly different dark on top of it.
        window.statusBarColor = Color.TRANSPARENT
        window.navigationBarColor = Color.TRANSPARENT
        WindowCompat.getInsetsController(window, binding.root).apply {
            isAppearanceLightStatusBars = false
            isAppearanceLightNavigationBars = false
        }

        // The keyboard, by hand.
        //
        // `adjustResize` does nothing once the decor has stopped fitting the
        // system windows, so without this the chat field somebody just tapped
        // is behind the keyboard they are typing on. Padding the root is what
        // `adjustResize` would have done, and the page sees the viewport shrink
        // exactly as it does in a browser.
        ViewCompat.setOnApplyWindowInsetsListener(binding.root) { view, insets ->
            val keyboard = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
            view.setPadding(0, 0, 0, keyboard)
            insets
        }

        val webView = binding.webView
        webView.settings.apply {
            javaScriptEnabled = true
            // The game keeps what it can offline — the local world in
            // `/admin/play` lives in IndexedDB, and `sessionStorage` holds which
            // character this instance is playing.
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            // Appended rather than replacing, so the server still sees a real
            // Chrome string and the suffix is additional information.
            userAgentString = "$userAgentString ${Config.USER_AGENT_SUFFIX}"
            // `app/lib/useNoZoom.ts` already refuses every zoom gesture the page
            // can see. These are the ones it cannot: the WebView's own controls.
            setSupportZoom(false)
            builtInZoomControls = false
            displayZoomControls = false
        }

        // Cookies are kept in memory until flushed, so a process killed in the
        // background takes the session with it and the next launch is a sign-in
        // screen. @see onPause
        CookieManager.getInstance().setAcceptCookie(true)

        // A game is not a document: the overscroll glow fires on every walk
        // that reaches the edge of the view, and the screen must not dim during
        // the minutes somebody spends watching a fight without touching
        // anything.
        webView.overScrollMode = View.OVER_SCROLL_NEVER
        webView.keepScreenOn = true
        webView.setBackgroundColor(INK)

        webView.webViewClient = GameClient()

        if (savedInstanceState == null) {
            webView.loadUrl(Config.ORIGIN)
        } else {
            webView.restoreState(savedInstanceState)
        }

        binding.retry.setOnClickListener { load() }

        // Back goes back through the game's own routes — the character chooser
        // behind the world, the sign-in behind that — and leaves the app once
        // there is nothing behind it. Anything else would trap somebody in the
        // world with no way out but the task switcher.
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) webView.goBack() else finish()
            }
        })
    }

    private fun load() {
        binding.offline.visibility = View.GONE
        binding.webView.visibility = View.VISIBLE
        binding.webView.loadUrl(Config.ORIGIN)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        binding.webView.saveState(outState)
    }

    override fun onPause() {
        super.onPause()
        // Write the session cookie down before the process can be reclaimed.
        CookieManager.getInstance().flush()
    }

    private inner class GameClient : WebViewClient() {
        /**
         * One host, and everything else belongs to the reader.
         *
         * A shell that follows any link the page contains is a browser with no
         * address bar and no way back. Off-origin links go to the system
         * browser, where there is a URL to read and a tab to close.
         */
        override fun shouldOverrideUrlLoading(
            view: WebView,
            request: WebResourceRequest,
        ): Boolean {
            val url = request.url
            if (url.host == Config.HOST) return false
            if (url.scheme == "https" || url.scheme == "http") {
                startActivity(Intent(Intent.ACTION_VIEW, url))
            }
            return true
        }

        /**
         * The load never started: no network, no DNS, no server.
         *
         * **This is the difference between a shell and a blank window.** A
         * WebView whose load fails shows its own terse error page with no way to
         * try again, and an app that does that on a reviewer's flaky connection
         * is an app that looks broken.
         *
         * Only for the page itself. A sub-resource that failed — a font, one
         * tileset — is not a reason to take the world off the screen.
         */
        override fun onReceivedError(
            view: WebView,
            request: WebResourceRequest,
            error: WebResourceError,
        ) {
            if (!request.isForMainFrame) return
            binding.message.text = error.description
            binding.webView.visibility = View.GONE
            binding.offline.visibility = View.VISIBLE
        }

        override fun onPageFinished(view: WebView, url: String) {
            if (binding.offline.visibility != View.VISIBLE) {
                binding.webView.visibility = View.VISIBLE
            }
        }
    }

    private companion object {
        /**
         * `--color-ink` in `app/app.css`, and the `theme-color` meta tag in
         * `app/root.tsx`. Kept in sync by hand, on the same terms those two are.
         */
        const val INK = 0xFF1A1A1A.toInt()
    }
}
