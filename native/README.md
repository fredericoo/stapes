# The native shells

Two apps, one game. Each is a window that loads `https://your-domain/` and
does the handful of things a web page cannot do for itself: keep the screen
awake, hold the session across launches, and say something useful when the
world cannot be reached.

**Neither shell contains a copy of the game.** That is the decision everything
else here follows from, and `docs/notes.md` has the long version under "The
native shells load the server, they do not carry the game".

## Before the first build

Three things are written down with a placeholder in them. All three have to
change together, and the host appears twice on each platform:

| | iOS | Android |
|---|---|---|
| Origin | `ios/Stapes/Config.swift` | `android/app/src/main/java/app/stapes/Config.kt` |
| Host, again | `WKAppBoundDomains` in `ios/Stapes/Info.plist` | — |
| Bundle / application id | `PRODUCT_BUNDLE_IDENTIFIER` in `ios/project.yml` | `applicationId` in `android/app/build.gradle.kts` |

The iOS app icon is the one file not in the repository: drop a 1024×1024 PNG at
`ios/Stapes/Assets.xcassets/AppIcon.appiconset/icon-1024.png` and Xcode
generates the rest. Android's is a vector and is already there.

## iOS

```bash
brew install xcodegen
cd native/ios
xcodegen generate
open Stapes.xcodeproj
```

`Stapes.xcodeproj` is generated and gitignored — `project.yml` is the project.
Anything set by hand in Xcode's build settings is lost on the next
`xcodegen generate`, so settings go in `project.yml`.

Set your team once under Signing & Capabilities, then Product → Archive.

## Android

```bash
cd native/android
./gradlew installDebug          # onto a connected device
./gradlew bundleRelease         # the .aab Play Console wants
```

A release build needs a keystore. It does not belong in the repository — put
the four `signing.*` properties in `~/.gradle/gradle.properties`, or supply
them from the environment in CI.

There is no Gradle wrapper checked in. Run `gradle wrapper` once in
`native/android` with a local Gradle, or open the directory in Android Studio
and let it do the same.

## Getting it approved

Guideline 4.2 is what rejects a webview wrapper, and it is not satisfied by
arguing. What is in here because of it:

- **Offline handling.** A `WKWebView` or `WebView` whose load fails shows a
  blank window or Chromium's own error page, and neither offers a way to try
  again. Both shells put a native screen in front with a retry button. This is
  the single most likely thing to go wrong on a reviewer's connection.
- **The screen stays awake** while the app is in front, because nobody taps for
  minutes at a time during a fight.
- **Links leave.** Anything off-origin opens in the system browser rather than
  stranding somebody in a window with no address bar.
- **The launch is not a white flash.** Both shells paint ink before the page
  exists.
- **Crash recovery on iOS.** The system reclaims memory from a background WebGL
  context by killing the web content process, and a shell that does not reload
  after that comes back permanently blank.

Still yours to do, and neither can be done from a repository:

- **`PrivacyInfo.xcprivacy` is filled in but App Store Connect asks again.** The
  privacy questionnaire in the listing has to say the same thing the manifest
  does: an email address, an account identifier, and chat, all for app
  functionality, none of it for tracking. Play Console's Data Safety form is the
  same answers in a different shape.
- **A demo account in App Review notes.** The game is behind a sign-in, and a
  reviewer who cannot get past it rejects the build. Give them a username and
  password, and a character already created.
- **Age rating.** There is combat. Both stores ask.

One thing that is not a problem today and becomes one the moment it changes:
the shops trade in currency the world mints. Sell anything for real money and
Apple's 3.1.1 requires it go through In-App Purchase, which is a different
conversation and a different app.

## Known rough edges

- **Coming back from the background waits on the reconnect backoff.** iOS
  suspends the webview, the socket dies, and JS timers do not run while
  suspended — so foregrounding can sit on a dark board for up to the ten seconds
  `RECONNECT_MAX_MS` allows. Fixing it properly is a second bridge that nudges
  the page on `scenePhase == .active`.
- **A cold launch lands on the character chooser.** `app/lib/playing.ts` keeps
  which character this instance is playing in `sessionStorage`, deliberately —
  two tabs playing two of an account's three characters is the case it protects.
  A shell has one window and no second tab, so the property buys nothing there
  and costs a tap on every launch.
