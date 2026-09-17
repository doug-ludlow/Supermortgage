import SwiftUI

/// `.ag-chip`: 12/16 in a 100pt pill, colored by status (needs you · running · done · needs a connection).
struct Chip: View {
    let text: String
    var status: WorkStatus? = nil
    /// `.ag-tag` on a feed post: `accentSoft` with `accentText`, 2pt/8pt padding.
    var tag: Bool = false

    @Environment(\.tokens) private var t

    var body: some View {
        Text(text)
            .textStyle(weight)
            .foregroundStyle(foreground)
            .padding(.vertical, tag ? 2 : 1)
            .padding(.horizontal, 8)
            .background(background)
            .clipShape(Capsule())
            .overlay(
                Capsule().strokeBorder(status == .needsConnection ? t.accent : Color.clear,
                                       style: StrokeStyle(lineWidth: 1, dash: [3, 3]))
            )
            .lineLimit(1)
    }

    private var weight: TextStyle {
        (status == .needsYou || tag) ? .metaMedium : .meta
    }

    private var foreground: Color {
        if tag { return t.accentText }
        switch status {
        case .needsYou, .needsConnection: return t.accentText
        case .running: return t.text
        default: return t.muted
        }
    }

    private var background: Color {
        if tag { return t.accentSoft }
        switch status {
        case .needsYou: return t.accentSoft
        case .running: return t.selected
        case .needsConnection: return Color.clear
        default: return t.subtle
        }
    }
}

/// `.ag-row .dot`: the 10pt status dot.
struct StatusDot: View {
    let status: WorkStatus

    @Environment(\.tokens) private var t

    var body: some View {
        ZStack {
            if status == .needsYou {
                Circle().fill(t.accentSoft).frame(width: 18, height: 18)
            }
            switch status {
            case .running:
                Circle().fill(t.text)
            case .needsYou:
                Circle().fill(t.accent)
            case .done:
                Circle().fill(t.muted)
            case .waiting:
                Circle().strokeBorder(t.quiet, lineWidth: 2)
            case .needsConnection:
                Circle().strokeBorder(t.accent, style: StrokeStyle(lineWidth: 2, dash: [2, 2]))
            case .doesntApply:
                Circle().strokeBorder(t.line, lineWidth: 1)
            }
        }
        .frame(width: 10, height: 10)
        .accessibilityHidden(true)
    }
}
