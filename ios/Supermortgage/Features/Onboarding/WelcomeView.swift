import SwiftUI

/// Welcome — the mark, the title in `muted`, the subheader, a spinner low on the page. Auto-advances after 2.6s.
struct WelcomeView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.tokens) private var t

    var body: some View {
        GeometryReader { geo in
            VStack(spacing: 0) {
                BrandMark(size: 86)
                    .frame(height: 66)
                    .padding(.trailing, 6)
                Text(Copy.welcomeTitle)
                    .textStyle(.welcomeTitle)
                    .foregroundStyle(t.muted)
                    .multilineTextAlignment(.center)
                    .padding(.top, 44)
                Text(Copy.welcomeSubtitle)
                    .textStyle(.body)
                    .foregroundStyle(t.muted)
                    .multilineTextAlignment(.center)
                    .padding(.top, 8)
                Spinner()
                    .padding(.top, geo.size.height * 0.34)
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity)
            .padding(.top, 58 + 26)
            .padding(.horizontal, 20)
            .padding(.bottom, 30)
        }
        .screenEnter()
        .onAppear { model.welcomeAppeared() }
        .accessibilityIdentifier("screen.welcome")
    }
}
