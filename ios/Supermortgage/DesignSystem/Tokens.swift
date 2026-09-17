import SwiftUI

/// The `:root` design tokens, light and dark. Resolved from the environment `colorScheme`
/// (which the in-app Appearance setting overrides through `preferredColorScheme`).
struct Tokens {
    let isDark: Bool
    let text: Color
    let paper: Color
    let surface: Color
    let bubble: Color
    let muted: Color
    let quiet: Color
    let line: Color
    let cardLine: Color
    let fieldLine: Color
    let choiceLine: Color
    let subtle: Color
    let selected: Color
    let accent: Color
    let button: Color
    let accentPressed: Color
    let accentSoft: Color
    let accentText: Color
    let userFrom: Color
    let userTo: Color
    let userText: Color
    let chrome: Color
    let chromeEdge: Color
    let paperGlass: Color
    let paperFade: Color
    let handle: Color
    /// The Goals bar's pending segment (#e08a8f light, #a8474d dark).
    let pendingBar: Color
    /// `--shadow: 0 8px 32px` and `--card-shadow: 0 7px 25px` alpha.
    let shadowOpacity: Double
    let cardShadowOpacity: Double
    /// The hairlines inside a chat key-value block (#00000012 / #ffffff14 and #00000010 / #ffffff10).
    let kvTop: Color
    let kvRow: Color

    static let light = Tokens(
        isDark: false,
        text: Color(hex: 0x080808), paper: Color(hex: 0xFCFCFC), surface: Color(hex: 0xFFFFFF), bubble: Color(hex: 0xEAEAEA),
        muted: Color(hex: 0x68686A), quiet: Color(hex: 0xA2A2A4), line: Color(hex: 0xE5E5E5), cardLine: Color(hex: 0xDEDEDE),
        fieldLine: Color(hex: 0xBABABC), choiceLine: Color(hex: 0xAAAAAA), subtle: Color(hex: 0xF4F4F4), selected: Color(hex: 0xEBEBEB),
        accent: Color(hex: 0xBF242B), button: Color(hex: 0xBF242B), accentPressed: Color(hex: 0xAA1D24), accentSoft: Color(hex: 0xF9E1E2), accentText: Color(hex: 0x842128),
        userFrom: Color(hex: 0xFAEDED), userTo: Color(hex: 0xF6CFD2), userText: Color(hex: 0x4E4142),
        chrome: Color(hex: 0xFFFFFF, opacity: 0.92), chromeEdge: Color(hex: 0xFFFFFF), paperGlass: Color(hex: 0xFCFCFC, opacity: 0.96),
        paperFade: Color(hex: 0xFCFCFC, opacity: 0.61), handle: Color(hex: 0xD5D5D5), pendingBar: Color(hex: 0xE08A8F),
        shadowOpacity: 0.043, cardShadowOpacity: 0.016,
        kvTop: Color(hex: 0x000000, opacity: 0.07), kvRow: Color(hex: 0x000000, opacity: 0.063)
    )

    static let dark = Tokens(
        isDark: true,
        text: Color(hex: 0xF5F5F5), paper: Color(hex: 0x151516), surface: Color(hex: 0x222224), bubble: Color(hex: 0x2C2C2E),
        muted: Color(hex: 0xADADB2), quiet: Color(hex: 0x94949A), line: Color(hex: 0x38383B), cardLine: Color(hex: 0x414145),
        fieldLine: Color(hex: 0x68686D), choiceLine: Color(hex: 0x747479), subtle: Color(hex: 0x29292C), selected: Color(hex: 0x343437),
        accent: Color(hex: 0xEF858B), button: Color(hex: 0xBF242B), accentPressed: Color(hex: 0xA71E25), accentSoft: Color(hex: 0x382025), accentText: Color(hex: 0xF59B9F),
        userFrom: Color(hex: 0x37252A), userTo: Color(hex: 0x51262C), userText: Color(hex: 0xF8D9DC),
        chrome: Color(hex: 0x222224, opacity: 0.92), chromeEdge: Color(hex: 0x38383B), paperGlass: Color(hex: 0x151516, opacity: 0.96),
        paperFade: Color(hex: 0x151516, opacity: 0.61), handle: Color(hex: 0x58585E), pendingBar: Color(hex: 0xA8474D),
        shadowOpacity: 0.125, cardShadowOpacity: 0.094,
        kvTop: Color(hex: 0xFFFFFF, opacity: 0.078), kvRow: Color(hex: 0xFFFFFF, opacity: 0.063)
    )

    static func resolve(_ scheme: ColorScheme) -> Tokens {
        scheme == .dark ? .dark : .light
    }
}

extension Color {
    /// `Color(hex: 0xBF242B)`.
    init(hex: UInt32, opacity: Double = 1) {
        self.init(.sRGB,
                  red: Double((hex >> 16) & 0xFF) / 255,
                  green: Double((hex >> 8) & 0xFF) / 255,
                  blue: Double(hex & 0xFF) / 255,
                  opacity: opacity)
    }
}

private struct TokensKey: EnvironmentKey {
    static let defaultValue = Tokens.light
}

extension EnvironmentValues {
    var tokens: Tokens {
        get { self[TokensKey.self] }
        set { self[TokensKey.self] = newValue }
    }
}

/// Reads the environment color scheme and publishes the matching token set. Applied at the root,
/// on every sheet and on the Refinance cover, so tokens follow the in-app Appearance setting.
private struct TokenResolver: ViewModifier {
    @Environment(\.colorScheme) private var scheme

    func body(content: Content) -> some View {
        content.environment(\.tokens, Tokens.resolve(scheme))
    }
}

extension View {
    func resolvedTokens() -> some View {
        modifier(TokenResolver())
    }
}
