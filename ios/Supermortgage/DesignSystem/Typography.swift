import SwiftUI

/// The type ramp from the `:root` block, in fixed sizes (no Dynamic Type in the shell).
struct TextStyle {
    let size: CGFloat
    let line: CGFloat
    let weight: Font.Weight
    let tracking: CGFloat

    // body 17/22, tracking −0.3
    static let body = TextStyle(size: 17, line: 22, weight: .regular, tracking: -0.3)
    static let bodyMedium = TextStyle(size: 17, line: 22, weight: .medium, tracking: -0.3)
    static let bodySemibold = TextStyle(size: 17, line: 22, weight: .semibold, tracking: -0.3)
    // support 15/20
    static let support = TextStyle(size: 15, line: 20, weight: .regular, tracking: 0)
    static let supportMedium = TextStyle(size: 15, line: 20, weight: .medium, tracking: 0)
    static let supportSemibold = TextStyle(size: 15, line: 20, weight: .semibold, tracking: 0)
    // meta 12/16
    static let meta = TextStyle(size: 12, line: 16, weight: .regular, tracking: 0)
    static let metaMedium = TextStyle(size: 12, line: 16, weight: .medium, tracking: 0)
    // title 24/29, tracking −0.65, weight 600
    static let title = TextStyle(size: 24, line: 29, weight: .semibold, tracking: -0.65)
    // sheet title 22/27, weight 600
    static let sheetTitle = TextStyle(size: 22, line: 27, weight: .semibold, tracking: -0.5)
    // the big number 44/48, weight 600, tracking −1.6
    static let bigNumber = TextStyle(size: 44, line: 48, weight: .semibold, tracking: -1.6)
    // the number inside a chat bubble (`.message .big`) 26/30, tracking −0.8
    static let messageBig = TextStyle(size: 26, line: 30, weight: .semibold, tracking: -0.8)
    // onboarding h1 28/34 weight 500
    static let onboardingTitle = TextStyle(size: 28, line: 34, weight: .medium, tracking: -0.65)
    // welcome h1 30/36 weight 500
    static let welcomeTitle = TextStyle(size: 30, line: 36, weight: .medium, tracking: -0.75)
    // buttons 17/22 weight 500, tracking −0.35
    static let button = TextStyle(size: 17, line: 22, weight: .medium, tracking: -0.35)
    // the header name pill 15 weight 600, tracking −0.35
    static let pill = TextStyle(size: 15, line: 20, weight: .semibold, tracking: -0.35)
    // the Goals arrow (26, weight 400)
    static let arrow = TextStyle(size: 26, line: 30, weight: .regular, tracking: 0)
}

private struct TextStyleModifier: ViewModifier {
    let style: TextStyle

    func body(content: Content) -> some View {
        content
            .font(.system(size: style.size, weight: style.weight))
            .tracking(style.tracking)
            .lineSpacing(max(0, style.line - style.size * 1.2))
    }
}

extension View {
    func textStyle(_ style: TextStyle) -> some View {
        modifier(TextStyleModifier(style: style))
    }
}

extension Font {
    /// The brand mark: Georgia Italic, the HTML's `font: italic … Georgia, serif`.
    static func georgiaItalic(_ size: CGFloat) -> Font {
        .custom("Georgia-Italic", size: size)
    }
}
