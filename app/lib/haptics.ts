/**
 * A vibration, played by the native shell when the game is running inside one.
 *
 * **Nothing here reaches the browser's own `navigator.vibrate`, on purpose.**
 * Safari ignores it, Chrome on Android does not, and the result would be that
 * the same game buzzes in one mobile browser and not the other — a difference
 * nobody chose and nobody can turn off. A shell that offers haptics has opted
 * in by installing a bridge; a tab has not.
 *
 * The web side names *what happened* and never the waveform. Both platforms
 * have a vocabulary of stock feedback patterns tuned to their own hardware —
 * `UIImpactFeedbackGenerator` on iOS, `VibrationEffect` on Android — and a
 * duration in milliseconds picked here would throw all of that away to be worse
 * on both. See `native/ios/Stapes/Haptics.swift` and
 * `native/android/app/src/main/java/app/stapes/Haptics.kt`, which is where the
 * feel of each of these is decided.
 */

/** The things worth feeling. One, so far. */
export type HapticKind = "hit";

/**
 * The shells, as the page sees them.
 *
 * Two mechanisms because the platforms offer two: WebKit gives a page a message
 * handler per name registered by the host, and Android injects a named object
 * with methods on it. Neither is polyfillable into the other and both are three
 * lines, so the bridge speaks whichever it finds.
 */
declare global {
  interface Window {
    webkit?: {
      messageHandlers?: {
        stapesHaptics?: { postMessage(body: unknown): void };
      };
    };
    StapesNative?: { haptic(kind: string, intensity: number): void };
  }
}

/**
 * Is a native shell listening?
 *
 * Exported because the answer is worth having before doing work for a
 * vibration that nobody will feel, and because the two bridges are an
 * implementation detail that should stay in this file.
 */
export function hasHaptics(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean(
    window.webkit?.messageHandlers?.stapesHaptics || window.StapesNative,
  );
}

/**
 * Play one, if there is anything to play it on.
 *
 * `intensity` is 0 to 1 and is a hint rather than an instruction: it is how
 * much of *this body* the blow took, so a scratch and a near-fatal hit are not
 * the same thump. What each platform does with it — scale an impact, pick a
 * different stock effect, or ignore it — belongs to the shell.
 *
 * Never throws. A vibration is the least important thing happening on the frame
 * it is asked for, and a bridge that has gone away mid-session must not take
 * the tick handler down with it.
 */
export function haptic(kind: HapticKind, intensity = 1): void {
  if (typeof window === "undefined") return;
  // `Math.min` and `Math.max` both pass `NaN` straight through, and a division
  // by a `maxHp` of zero is one arithmetic slip away at the only call site. The
  // shells would hand it to `impactOccurred(intensity:)` and to an amplitude
  // between 1 and 255, neither of which has an answer for it.
  const clamped = Number.isFinite(intensity)
    ? Math.min(1, Math.max(0, intensity))
    : 1;
  try {
    const ios = window.webkit?.messageHandlers?.stapesHaptics;
    if (ios) {
      ios.postMessage({ kind, intensity: clamped });
      return;
    }
    window.StapesNative?.haptic(kind, clamped);
  } catch {
    // A shell that removed its handler, or one whose bridge object is a
    // stranger's. Silence is the right outcome either way.
  }
}
