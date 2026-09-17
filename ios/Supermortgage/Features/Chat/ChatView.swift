import SwiftUI

/// The thread, newest at the bottom, auto-scrolling on every append.
struct ChatView: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private let bottomAnchor = "chat.bottom"

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(spacing: 0) {
                    ForEach(model.chat) { message in
                        MessageBubble(message: message) { model.act($0) }
                            .id(message.id)
                    }
                    Color.clear
                        .frame(height: 1)
                        .id(bottomAnchor)
                }
                .padding(.top, 12)
                .padding(.horizontal, 16)
                .padding(.bottom, 15)
            }
            .scrollDismissesKeyboard(.interactively)
            .onAppear { scrollToBottom(proxy, animated: false) }
            .onChange(of: model.chat) { scrollToBottom(proxy, animated: true) }
        }
        .accessibilityIdentifier("screen.chat")
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy, animated: Bool) {
        if animated && !reduceMotion {
            withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo(bottomAnchor, anchor: .bottom) }
        } else {
            proxy.scrollTo(bottomAnchor, anchor: .bottom)
        }
    }
}
