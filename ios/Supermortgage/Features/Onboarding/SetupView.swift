import SwiftUI

/// "Setting up your agent" — the orb spinning over the heading, for 1.7s.
struct SetupView: View {
    @Environment(\.tokens) private var t

    var body: some View {
        VStack(spacing: 0) {
            Orb()
            Text(Copy.setupTitle)
                .textStyle(.onboardingTitle)
                .foregroundStyle(t.text)
                .multilineTextAlignment(.center)
                .padding(.top, 26)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.horizontal, 20)
        .screenEnter()
        .accessibilityIdentifier("screen.setup")
    }
}
