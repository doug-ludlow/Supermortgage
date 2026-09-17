import SwiftUI

/// "Here’s how I work:" — the mark, the heading, three intro points, the terms line and "Get started".
struct HowIWorkView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.tokens) private var t

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            BrandMark(size: 86)
                .frame(maxWidth: .infinity)
                .frame(height: 66)
                .padding(.trailing, 6)
                .padding(.top, 10)
                .padding(.bottom, 48)
            Text(Copy.knowTitle)
                .textStyle(.onboardingTitle)
                .foregroundStyle(t.text)
                .frame(maxWidth: .infinity)
                .multilineTextAlignment(.center)
                .padding(.bottom, 34)
            VStack(alignment: .leading, spacing: 28) {
                IntroPoint(symbol: "arrow.triangle.2.circlepath", title: Copy.introPoints[0].title, text: Copy.introPoints[0].body)
                IntroPoint(symbol: "wallet.pass", title: Copy.introPoints[1].title, text: Copy.introPoints[1].body)
                IntroPoint(symbol: "minus.circle", title: Copy.introPoints[2].title, text: Copy.introPoints[2].body)
            }
            .padding(.horizontal, 4)
            Spacer(minLength: 32)
            terms
                .padding(.bottom, 16)
            PrimaryButton(Copy.getStarted) { model.getStarted() }
        }
        .padding(.top, 58)
        .padding(.horizontal, 20)
        .padding(.bottom, 30)
        .screenEnter()
        .accessibilityIdentifier("screen.know")
    }

    /// The two link-styled words do nothing.
    private var terms: some View {
        (Text(Copy.termsPrefix)
            + Text(Copy.termsLink1).foregroundStyle(t.accentText)
            + Text(Copy.termsMiddle)
            + Text(Copy.termsLink2).foregroundStyle(t.accentText)
            + Text(Copy.termsSuffix))
            .textStyle(.meta)
            .foregroundStyle(t.muted)
            .fixedSize(horizontal: false, vertical: true)
    }
}
