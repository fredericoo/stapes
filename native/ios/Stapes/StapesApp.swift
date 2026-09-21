import SwiftUI
import UIKit

@main
struct StapesApp: App {
    var body: some Scene {
        WindowGroup {
            GameScreen()
        }
    }
}

/// The whole interface: a webview, and the two things that can be in front of
/// it.
struct GameScreen: View {
    @Environment(\.scenePhase) private var scenePhase
    @State private var state: LoadState = .loading
    @State private var reloadToken = 0

    var body: some View {
        ZStack {
            Color.ink.ignoresSafeArea()

            GameWebView(state: $state, reloadToken: reloadToken)
                .ignoresSafeArea()
                .opacity(isFailed ? 0 : 1)

            switch state {
            case .loading:
                ProgressView().tint(.white)
            case .failed(let message):
                OfflineView(message: message) { reloadToken += 1 }
                    .ignoresSafeArea()
            case .loaded:
                EmptyView()
            }
        }
        .preferredColorScheme(.dark)
        .onChange(of: scenePhase) { phase in
            // Nobody taps for minutes at a time while waiting out a fight or
            // reading a shop, and the screen dimming mid-round is the shell
            // interrupting the game. Released the moment the app is not the
            // thing on screen, so this never holds the display awake for an app
            // in the background.
            UIApplication.shared.isIdleTimerDisabled = phase == .active
        }
    }

    private var isFailed: Bool {
        if case .failed = state { return true }
        return false
    }
}
