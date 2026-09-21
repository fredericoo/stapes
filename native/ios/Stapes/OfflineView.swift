import SwiftUI

/// What is on screen when the origin cannot be reached.
///
/// Native rather than a page, necessarily: the case this covers is the one
/// where no page can be fetched. It says which of the two things went wrong as
/// far as it can tell — this device's connection, or the world being down — and
/// gives a way to ask again without force-quitting.
struct OfflineView: View {
    let message: String
    let retry: () -> Void

    var body: some View {
        VStack(spacing: 16) {
            Text("Can't reach the world")
                .font(.system(.title2, design: .monospaced).weight(.semibold))
            Text(message)
                .font(.system(.footnote, design: .monospaced))
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
            Button(action: retry) {
                Text("Try again")
                    .font(.system(.body, design: .monospaced).weight(.semibold))
                    .padding(.horizontal, 24)
                    .padding(.vertical, 12)
            }
            .buttonStyle(.borderedProminent)
            .tint(.white)
            .foregroundStyle(Color.ink)
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color.ink)
        .foregroundStyle(.white)
    }
}
