import UIKit

/// The feel of a blow.
///
/// **The web side names the event and this decides the waveform.** A duration
/// in milliseconds chosen in TypeScript would be the same number on a phone
/// with a Taptic Engine and one without, and worse than the stock patterns on
/// both. @see `app/lib/haptics.ts`
enum Haptics {
    /// Prepared ahead, and kept.
    ///
    /// A generator that has not been prepared warms the engine on first use,
    /// and the first thump of a fight is the one that arrives late — which is
    /// the one that matters, because it is the one telling you a fight started.
    /// Holding it also means the engine stays warm through a flurry of blows
    /// rather than spinning up per hit.
    private static let impact = UIImpactFeedbackGenerator(style: .medium)

    static func prepare() {
        impact.prepare()
    }

    /// Play one.
    ///
    /// `intensity` is how much of the body the blow took, 0 to 1. It is passed
    /// through to the impact rather than used to pick between styles, because
    /// a continuous range is exactly what the API takes and a three-way
    /// staircase would be a worse version of it.
    ///
    /// Floored, because a blow that took a sliver is still a blow and a thump
    /// too faint to feel reads as a bug in the haptics rather than as a scratch.
    static func play(kind: String, intensity: Double) {
        guard kind == "hit" else { return }
        let strength = min(1.0, max(0.35, intensity))
        impact.impactOccurred(intensity: CGFloat(strength))
        // Re-arm for the next one. A generator goes cold shortly after firing.
        impact.prepare()
    }
}
