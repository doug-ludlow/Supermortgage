import SwiftUI

/// `.primary`: 44pt capsule, `button` fill (pressed: `accentPressed`), white 17pt medium label.
struct PrimaryButton: View {
    let title: String
    let action: () -> Void

    @Environment(\.tokens) private var t

    init(_ title: String, action: @escaping () -> Void) {
        self.title = title
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            Text(title)
        }
        .buttonStyle(CapsuleButtonStyle(fill: t.button, pressed: t.accentPressed, label: .white))
        .accessibilityIdentifier("button.\(title)")
    }
}

/// `.secondary`: the same shape on `bubble`, with the text color.
struct SecondaryButton: View {
    let title: String
    var fill: Color? = nil
    let action: () -> Void

    @Environment(\.tokens) private var t

    init(_ title: String, fill: Color? = nil, action: @escaping () -> Void) {
        self.title = title
        self.fill = fill
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            Text(title)
        }
        .buttonStyle(CapsuleButtonStyle(fill: fill ?? t.bubble, pressed: t.selected, label: t.text))
        .accessibilityIdentifier("button.\(title)")
    }
}

struct CapsuleButtonStyle: ButtonStyle {
    let fill: Color
    let pressed: Color
    let label: Color
    var fullWidth: Bool = true
    var minHeight: CGFloat = 44

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .textStyle(.button)
            .foregroundStyle(label)
            .multilineTextAlignment(.center)
            .padding(.horizontal, 16)
            .padding(.vertical, 10)
            .frame(maxWidth: fullWidth ? .infinity : nil, minHeight: minHeight)
            .background(configuration.isPressed ? pressed : fill)
            .clipShape(Capsule())
            .contentShape(Capsule())
    }
}

/// `.link`: an inline 15pt `muted` text button, 44pt tall.
struct LinkButton: View {
    let title: String
    var color: Color? = nil
    let action: () -> Void

    @Environment(\.tokens) private var t

    init(_ title: String, color: Color? = nil, action: @escaping () -> Void) {
        self.title = title
        self.color = color
        self.action = action
    }

    var body: some View {
        Button(action: action) {
            Text(title)
                .textStyle(.support)
                .foregroundStyle(color ?? t.muted)
                .padding(.vertical, 10)
                .padding(.horizontal, 3)
                .frame(minHeight: 44)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("link.\(title)")
    }
}

/// `.icon-button`: a 44pt round hit area with an icon; `chrome` adds the header's glass background.
struct IconButton: View {
    let icon: IconName
    var iconSize: CGFloat = 24
    var size: CGFloat = 44
    var chrome: Bool = false
    var background: Color? = nil
    let label: String
    let action: () -> Void

    @Environment(\.tokens) private var t

    var body: some View {
        Button(action: action) {
            Icon(icon, size: iconSize)
                .foregroundStyle(t.text)
                .frame(width: size, height: size)
                .background(chrome ? t.chrome : (background ?? .clear))
                .clipShape(Circle())
                .overlay(Circle().strokeBorder(chrome ? t.surface : .clear, lineWidth: 1))
                .shadow(color: .black.opacity(chrome ? t.shadowOpacity : 0), radius: 16, x: 0, y: 8)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}
