import Foundation

/// Where the game is.
///
/// **The shell holds no copy of the game.** It loads this origin and shows
/// whatever comes back, which is what keeps the session cookie first-party, the
/// socket same-origin and the API base URL absent — see `docs/notes.md`, "The
/// native shells load the server, they do not carry the game". A build that
/// bundled the client would be a build that needs App Review to ship a protocol
/// change.
///
/// **This host is written down twice** and both copies have to agree: here, and
/// in `WKAppBoundDomains` in `Info.plist`. The second is what lets WebKit treat
/// the page as the app's own — persistent cookies across launches, and
/// `evaluateJavaScript` — and a mismatch is a game that loads and then signs
/// you out every time you close it.
enum Config {
    static let origin = URL(string: "https://stapes.example.com")!

    /// The one host this shell will navigate to. Anything else a page links to
    /// belongs to the reader and goes to their browser.
    static var host: String { origin.host ?? "" }

    /// Appended to the WebKit user agent, so the server and its logs can tell
    /// an app session from a tab. It is the whole of how the page knows it is
    /// in a shell, apart from the bridges themselves.
    static let userAgentSuffix = "StapesiOS"
}
