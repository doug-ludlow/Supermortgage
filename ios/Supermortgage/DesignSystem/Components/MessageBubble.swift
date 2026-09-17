import SwiftUI

/// `.message`: an assistant bubble (`bubble`, 22/22/22/6) or a user bubble (the gradient, 22/22/6/22),
/// with the text, bullets, the number and its key-value block, a status row or the typing dots,
/// and the dashed option chips underneath.
struct MessageBubble: View {
    let message: Message
    let onOption: (ChatAction) -> Void

    @Environment(\.tokens) private var t

    private var isUser: Bool { message.role == .user }
    private var hasOptions: Bool { !message.visibleOptions.isEmpty }

    var body: some View {
        HStack(spacing: 0) {
            if isUser { Spacer(minLength: 32) }
            bubble
            if !isUser && !hasOptions { Spacer(minLength: 22) }
        }
        .padding(.top, 6)
    }

    private var bubble: some View {
        VStack(alignment: .leading, spacing: 0) {
            content
            if hasOptions {
                VStack(spacing: 8) {
                    ForEach(message.visibleOptions) { option in
                        ChatChoice(option: option) { onOption(option.action) }
                    }
                }
                .padding(.top, 12)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .frame(maxWidth: hasOptions ? CGFloat.infinity : nil, alignment: .leading)
        .background(background)
        .clipShape(UnevenRoundedRectangle(
            topLeadingRadius: 22,
            bottomLeadingRadius: isUser ? 22 : 6,
            bottomTrailingRadius: isUser ? 6 : 22,
            topTrailingRadius: 22,
            style: .continuous))
        .accessibilityElement(children: .contain)
        .accessibilityLabel(isUser ? "You" : "Agent")
    }

    @ViewBuilder
    private var background: some View {
        if isUser {
            LinearGradient(colors: [t.userFrom, t.userTo], startPoint: .topLeading, endPoint: .bottomTrailing)
        } else {
            t.bubble
        }
    }

    private var textColor: Color { isUser ? t.userText : t.text }

    @ViewBuilder
    private var content: some View {
        switch message.body {
        case .typing:
            TypingIndicator()
        case .text(let text):
            Text(text)
                .textStyle(.body)
                .foregroundStyle(textColor)
                .fixedSize(horizontal: false, vertical: true)
        case .bullets(let lead, let items):
            VStack(alignment: .leading, spacing: 0) {
                Text(lead)
                    .textStyle(.body)
                    .foregroundStyle(textColor)
                    .fixedSize(horizontal: false, vertical: true)
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(Array(items.enumerated()), id: \.offset) { _, spans in
                        HStack(alignment: .top, spacing: 0) {
                            Text("•")
                                .textStyle(.body)
                                .frame(width: 18, alignment: .leading)
                            RichText(spans: spans)
                                .textStyle(.body)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        .foregroundStyle(textColor)
                    }
                }
                .padding(.top, 8)
                .padding(.vertical, 6)
            }
        case .number(let lead, let amount, let rows):
            VStack(alignment: .leading, spacing: 0) {
                Text(lead)
                    .textStyle(.body)
                    .foregroundStyle(textColor)
                    .fixedSize(horizontal: false, vertical: true)
                if let amount {
                    Text(amount)
                        .textStyle(.messageBig)
                        .foregroundStyle(textColor)
                        .padding(.top, 6)
                        .padding(.bottom, 2)
                        .accessibilityIdentifier("chat.number")
                }
                VStack(spacing: 0) {
                    ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                        HStack(alignment: .firstTextBaseline, spacing: 12) {
                            Text(row.key)
                                .textStyle(.support)
                                .foregroundStyle(t.muted)
                            Spacer(minLength: 0)
                            Text(row.value)
                                .textStyle(.supportMedium)
                                .foregroundStyle(textColor)
                                .multilineTextAlignment(.trailing)
                        }
                        .padding(.vertical, 8)
                        .overlay(alignment: .top) {
                            if index > 0 { Rectangle().fill(t.kvRow).frame(height: 1) }
                        }
                    }
                }
                .padding(.top, 4)
                .overlay(alignment: .top) { Rectangle().fill(t.kvTop).frame(height: 1) }
                .padding(.top, 12)
            }
        case .progress(let state):
            StatusRow(text: state.done ?? state.loading, small: state.small, done: state.isDone)
                .padding(.top, 10)
                .padding(.bottom, -4)
        }
    }
}

/// Text built from `Span`s, bold where the prototype has `<strong>`.
struct RichText: View {
    let spans: [Span]

    var body: some View {
        spans.reduce(Text("")) { partial, span in
            partial + (span.bold ? Text(span.text).fontWeight(.semibold) : Text(span.text))
        }
    }
}
