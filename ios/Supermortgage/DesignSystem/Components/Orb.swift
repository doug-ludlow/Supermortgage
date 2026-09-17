import SwiftUI

/// `.orb.working`: a 56pt ring, 7pt thick — `accent` across the top and right, #e64d53 at the bottom,
/// open on the left — tilted −25° and turning once every 1.3s.
struct Orb: View {
    @Environment(\.tokens) private var t
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var spinning = false

    var body: some View {
        ZStack {
            Circle().trim(from: 0.625, to: 1).stroke(t.accent, lineWidth: 7)
            Circle().trim(from: 0, to: 0.125).stroke(t.accent, lineWidth: 7)
            Circle().trim(from: 0.125, to: 0.375).stroke(Color(hex: 0xE64D53), lineWidth: 7)
        }
        .padding(3.5)
        .frame(width: 56, height: 56)
        .rotationEffect(.degrees(spinning ? 335 : -25))
        .animation(reduceMotion ? nil : .linear(duration: 1.3).repeatForever(autoreverses: false), value: spinning)
        .onAppear { spinning = true }
        .accessibilityHidden(true)
    }
}
