import SwiftUI

/// The agent's face: `AVATAR` drawn natively (the same paths, gradient and dots as the SVG in the
/// asset catalog) so it renders identically in light and dark. 66×66 with a soft drop shadow.
struct AvatarMark: View {
    var body: some View {
        Canvas { context, size in
            let scale = size.width / 66
            context.scaleBy(x: scale, y: scale)
            let hood = SVGPath.path("M33 4c15 0 25 12 25 30 0 16-8 28-25 28S8 50 8 34C8 16 18 4 33 4z")
            context.fill(hood, with: .linearGradient(
                Gradient(colors: [Color(hex: 0xD3343B), Color(hex: 0xA51D24)]),
                startPoint: CGPoint(x: 33, y: 4), endPoint: CGPoint(x: 33, y: 62)))
            context.fill(Path(ellipseIn: CGRect(x: 17, y: 21, width: 32, height: 34)), with: .color(Color(hex: 0xF6E9DC)))
            let eye = Color(hex: 0x2A2A2A)
            context.fill(Path(ellipseIn: CGRect(x: 27 - 1.9, y: 36 - 1.9, width: 3.8, height: 3.8)), with: .color(eye))
            context.fill(Path(ellipseIn: CGRect(x: 39 - 1.9, y: 36 - 1.9, width: 3.8, height: 3.8)), with: .color(eye))
            context.stroke(SVGPath.path("M28 43q5 4 10 0"), with: .color(eye), style: StrokeStyle(lineWidth: 1.7, lineCap: .round))
            let cheek = Color(hex: 0xF3B7BB, opacity: 0.85)
            context.fill(Path(ellipseIn: CGRect(x: 23.5 - 2.2, y: 41 - 2.2, width: 4.4, height: 4.4)), with: .color(cheek))
            context.fill(Path(ellipseIn: CGRect(x: 42.5 - 2.2, y: 41 - 2.2, width: 4.4, height: 4.4)), with: .color(cheek))
        }
        .frame(width: 66, height: 66)
        .shadow(color: .black.opacity(0.08), radius: 5, x: 0, y: 6)
        .accessibilityHidden(true)
    }
}

/// The avatar with its working ring: a thin `accentSoft` ring with an `accent` arc turning once per 1.5s.
struct AvatarView: View {
    let working: Bool

    @Environment(\.tokens) private var t
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var spinning = false

    var body: some View {
        ZStack {
            AvatarMark()
            if working {
                ZStack {
                    Circle().stroke(t.accentSoft, lineWidth: 2)
                    Circle().trim(from: 0.625, to: 0.875).stroke(t.accent, lineWidth: 2)
                }
                .frame(width: 74, height: 74)
                .rotationEffect(.degrees(spinning ? 360 : 0))
                .animation(reduceMotion ? nil : .linear(duration: 1.5).repeatForever(autoreverses: false), value: spinning)
                .onAppear { spinning = true }
                .onDisappear { spinning = false }
            }
        }
        .frame(width: 76, height: 76)
    }
}

/// The brand mark "s" in Georgia Italic, `accent`.
struct BrandMark: View {
    var size: CGFloat = 86

    @Environment(\.tokens) private var t

    var body: some View {
        Text("s")
            .font(.georgiaItalic(size))
            .foregroundStyle(t.accent)
            .accessibilityHidden(true)
    }
}
