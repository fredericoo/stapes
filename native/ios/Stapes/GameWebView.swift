import SwiftUI
import UIKit
import WebKit

/// What the shell is currently showing.
enum LoadState: Equatable {
    case loading
    case loaded
    /// The origin could not be reached. Carries what to tell somebody about it.
    case failed(String)
}

/// The game, in a `WKWebView`, owning the whole screen.
///
/// **The page is given the full display and is not inset.** `app/root.tsx` sets
/// `viewport-fit=cover` and insets its own chrome with `env(safe-area-inset-*)`
/// — see `AppShell` and `GameViewport` — so a shell that also inset it would
/// double every inset, and a shell that let UIKit inset it would put the cream
/// page background in the bands behind the status bar and the home indicator.
/// That is the exact bug the comment in `root.tsx` describes, arriving by
/// another route.
struct GameWebView: UIViewRepresentable {
    @Binding var state: LoadState

    /// Bumped to ask for a fresh load. A counter rather than a closure because
    /// `updateUIView` is the only place a representable may touch its view, and
    /// comparing tokens is how it knows this update is the retry.
    let reloadToken: Int

    func makeCoordinator() -> Coordinator {
        Coordinator(state: $state)
    }

    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()

        // The page is the app's own, as far as WebKit is concerned. This is
        // what keeps the session cookie across launches instead of handing it
        // to Intelligent Tracking Prevention as a stranger's, and it is paired
        // with `WKAppBoundDomains` in `Info.plist`: the flag without the list is
        // an app that can navigate nowhere at all.
        configuration.limitsNavigationsToAppBoundDomains = true

        // The default store is the persistent one. Named rather than left
        // implicit because the non-persistent alternative is a one-line change
        // that would silently sign everybody out on every launch, and somebody
        // will reach for it while debugging.
        configuration.websiteDataStore = .default()

        // Appended to WebKit's own user agent rather than replacing it, so the
        // server still sees a real Safari string and the suffix is additional
        // information rather than a lie.
        configuration.applicationNameForUserAgent = Config.userAgentSuffix

        configuration.userContentController.add(
            context.coordinator, name: "stapesHaptics")

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        context.coordinator.webView = webView

        // A game is not a document. Swiping back has nowhere to go, the
        // rubber-band at the edges drags the whole board off centre for as long
        // as a finger is down, and the webview's own pinch-zoom competes with
        // `app/lib/useNoZoom.ts` for the same gesture.
        webView.allowsBackForwardNavigationGestures = false
        webView.scrollView.bounces = false
        webView.scrollView.alwaysBounceVertical = false
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.pinchGestureRecognizer?.isEnabled = false

        // Ink, matching the `theme-color` meta tag, so the moment before the
        // first paint is the colour the app is rather than white.
        webView.isOpaque = false
        webView.backgroundColor = .ink
        webView.scrollView.backgroundColor = .ink

        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {
        guard context.coordinator.servedToken != reloadToken else { return }
        context.coordinator.servedToken = reloadToken
        webView.load(URLRequest(url: Config.origin))
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        private let state: Binding<LoadState>
        weak var webView: WKWebView?

        /// The last `reloadToken` this has acted on. Starts below any real one
        /// so the first `updateUIView` is the initial load.
        var servedToken = -1

        init(state: Binding<LoadState>) {
            self.state = state
        }

        // MARK: Where the page may go

        /// One host, and everything else belongs to the reader.
        ///
        /// A shell that follows any link the page contains is a browser with no
        /// address bar and no way back, which is both a bad experience and the
        /// reading of guideline 4.2 that gets a wrapper rejected. Off-origin
        /// links go to the system browser, where there is a URL to read and a
        /// tab to close.
        func webView(
            _ webView: WKWebView,
            decidePolicyFor navigationAction: WKNavigationAction,
            decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
        ) {
            guard let url = navigationAction.request.url else {
                decisionHandler(.cancel)
                return
            }
            if url.host == Config.host {
                decisionHandler(.allow)
                return
            }
            // `target="_blank"` arrives with no frame to load into, and would
            // otherwise be silently dropped.
            let external = navigationAction.navigationType == .linkActivated
                || navigationAction.targetFrame == nil
            if external, let scheme = url.scheme,
               scheme == "https" || scheme == "http" {
                UIApplication.shared.open(url)
            }
            decisionHandler(.cancel)
        }

        // MARK: What the shell shows while that happens

        func webView(
            _ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!
        ) {
            state.wrappedValue = .loading
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            state.wrappedValue = .loaded
        }

        /// The load never started: no network, no DNS, no server.
        ///
        /// **This is the difference between a shell and a blank window.** A
        /// `WKWebView` whose load fails shows nothing at all and offers no way
        /// to try again, and an app that does that on the reviewer's flaky
        /// hotel wifi is an app that gets rejected for being broken.
        func webView(
            _ webView: WKWebView,
            didFailProvisionalNavigation navigation: WKNavigation!,
            withError error: Error
        ) {
            state.wrappedValue = .failed(error.localizedDescription)
        }

        func webView(
            _ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error
        ) {
            state.wrappedValue = .failed(error.localizedDescription)
        }

        /// The web content process died — almost always the system reclaiming
        /// memory from a WebGL context in the background.
        ///
        /// Without this the app comes back to a permanently blank webview that
        /// no amount of tapping fixes, because nothing is left to redraw.
        func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
            webView.load(URLRequest(url: Config.origin))
        }

        // MARK: The bridge

        func userContentController(
            _ userContentController: WKUserContentController,
            didReceive message: WKScriptMessage
        ) {
            guard message.name == "stapesHaptics",
                  let body = message.body as? [String: Any],
                  let kind = body["kind"] as? String
            else { return }
            let intensity = body["intensity"] as? Double ?? 1
            Haptics.play(kind: kind, intensity: intensity)
        }
    }
}

extension UIColor {
    /// `--color-ink` in `app/app.css`, and the `theme-color` meta tag in
    /// `app/root.tsx`. Kept in sync by hand, on the same terms those two are.
    static let ink = UIColor(red: 0x1A / 255, green: 0x1A / 255, blue: 0x1A / 255, alpha: 1)
}

extension Color {
    static let ink = Color(UIColor.ink)
}
