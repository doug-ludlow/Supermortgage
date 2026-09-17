import SwiftUI

/// `.spinner`: 18×18, a 2pt `accentSoft` ring with an `accent` top, one turn per second.
struct Spinner: View {
    var size: CGFloat = 18
    var topColor: Color? = nil

    @Environment(\.tokens) private var t
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var spinning = false

    var body: some View {
        ZStack {
            Circle().stroke(t.accentSoft, lineWidth: 2)
            Circle().trim(from: 0.625, to: 0.875).stroke(topColor ?? t.accent, lineWidth: 2)
        }
        .padding(1)
        .frame(width: size, height: size)
        .rotationEffect(.degrees(spinning ? 360 : 0))
        .animation(reduceMotion ? nil : .linear(duration: 1).repeatForever(autoreverses: false), value: spinning)
        .onAppear { spinning = true }
        .accessibilityHidden(true)
    }
}
