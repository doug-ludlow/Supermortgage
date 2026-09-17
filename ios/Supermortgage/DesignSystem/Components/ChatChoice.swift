import SwiftUI

/// `.chat-choice`: a full-width, 44pt option with a dashed `choiceLine` border and 8pt corners;
/// `.primaryish` is a solid `accent` border with an `accentText` label.
struct ChatChoice: View {
    let option: ChatOption
    let action: () -> Void

    @Environment(\.tokens) private var t

    var body: some View {
        Button(action: action) {
            Text(option.label)
                .textStyle(option.primary ? .bodyMedium : .body)
                .foregroundStyle(option.primary ? t.accentText : t.text)
                .multilineTextAlignment(.leading)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 10)
                .padding(.vertical, 9)
                .frame(minHeight: 44)
                .overlay(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .strokeBorder(option.primary ? t.accent : t.choiceLine,
                                      style: StrokeStyle(lineWidth: 1, dash: option.primary ? [] : [3, 3]))
                )
                .contentShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("chat.option.\(option.label)")
    }
}
