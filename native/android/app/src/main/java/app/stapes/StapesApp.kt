package app.stapes

import android.app.Application
import android.webkit.WebView

class StapesApp : Application() {
    override fun onCreate() {
        super.onCreate()
        // Chromium's own remote debugging, in debug builds only. It is how you
        // attach Safari-style devtools to the shell, and it must never be on in
        // a release build: it exposes the page to any process on the device.
        if (BuildConfig.DEBUG) {
            WebView.setWebContentsDebuggingEnabled(true)
        }
    }
}
